import { useState, useCallback, useEffect, useRef } from 'react';
import { Question } from '../types';

export interface ChoiceData {
  selectedIndices: number[];
  optionCount: number;
  multiSelect: boolean;
  otherText?: string;
}

interface QuestionBlockProps {
  question: Question;
  onSelectOption: (label: string) => void | Promise<boolean>;
  onSelectChoice?: (choice: ChoiceData) => Promise<boolean>;
}

export function QuestionBlock({ question, onSelectOption, onSelectChoice }: QuestionBlockProps) {
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [showOther, setShowOther] = useState(false);
  const [otherText, setOtherText] = useState('');
  const blockRef = useRef<HTMLDivElement>(null);
  const [sendError, setSendError] = useState(false);
  const lastChoiceRef = useRef<ChoiceData | null>(null);

  useEffect(() => {
    if (sendError) {
      const t = setTimeout(() => setSendError(false), 5000);
      return () => clearTimeout(t);
    }
  }, [sendError]);

  const trySendChoice = useCallback(async (choice: ChoiceData) => {
    lastChoiceRef.current = choice;
    try {
      if (onSelectChoice) {
        const result = await onSelectChoice(choice);
        if (result === false) setSendError(true);
      }
    } catch {
      setSendError(true);
    }
  }, [onSelectChoice]);

  const handleRetry = useCallback(() => {
    setSendError(false);
    if (lastChoiceRef.current) trySendChoice(lastChoiceRef.current);
  }, [trySendChoice]);

  const handleOptionClick = useCallback((idx: number) => {
    if (question.multiSelect) {
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(idx)) {
          next.delete(idx);
        } else {
          next.add(idx);
        }
        return next;
      });
    } else if (onSelectChoice) {
      trySendChoice({
        selectedIndices: [idx],
        optionCount: question.options.length,
        multiSelect: false,
      });
    } else {
      onSelectOption(question.options[idx].label);
    }
  }, [question.multiSelect, question.options, onSelectOption, onSelectChoice, trySendChoice]);

  const handleSubmitMulti = useCallback(() => {
    if (selected.size === 0) return;
    const indices = Array.from(selected).sort((a, b) => a - b);
    if (onSelectChoice) {
      trySendChoice({
        selectedIndices: indices,
        optionCount: question.options.length,
        multiSelect: true,
      });
    } else {
      const labels = indices.map(i => question.options[i].label);
      onSelectOption(labels.join(', '));
    }
  }, [selected, question.options, onSelectOption, onSelectChoice, trySendChoice]);

  const handleSendOther = useCallback(() => {
    const trimmed = otherText.trim();
    if (!trimmed) return;
    if (onSelectChoice) {
      trySendChoice({
        selectedIndices: [],
        optionCount: question.options.length,
        multiSelect: question.multiSelect,
        otherText: trimmed,
      });
    } else {
      onSelectOption(trimmed);
    }
  }, [otherText, question.options.length, question.multiSelect, onSelectOption, onSelectChoice, trySendChoice]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      const num = parseInt(e.key);
      if (num >= 1 && num <= question.options.length) {
        e.preventDefault();
        handleOptionClick(num - 1);
      }
      if (e.key === 'Enter' && question.multiSelect && selected.size > 0) {
        e.preventDefault();
        handleSubmitMulti();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [question.options, question.multiSelect, selected, handleOptionClick, handleSubmitMulti]);

  const showDescriptions = question.options.some(o => o.description);

  return (
    <div className="question-block" ref={blockRef}>
      {question.header && (
        <div className="question-block-header">{question.header}</div>
      )}
      {question.question && (
        <div className="question-block-text">{question.question}</div>
      )}
      <div className={`question-block-options ${showDescriptions ? 'with-descriptions' : ''}`}>
        {question.options.map((opt, idx) => (
          <button
            key={opt.label}
            className={`msg-option-btn ${question.multiSelect && selected.has(idx) ? 'selected' : ''} ${showDescriptions ? 'with-desc' : ''}`}
            onClick={() => handleOptionClick(idx)}
            title={opt.description}
          >
            <span className="option-key-hint">{idx + 1}</span>
            <span className="option-label">{opt.label}</span>
            {showDescriptions && opt.description && (
              <span className="option-description">{opt.description}</span>
            )}
          </button>
        ))}
      </div>

      <div className="question-block-actions">
        {question.multiSelect && (
          <button
            className="question-block-submit"
            onClick={handleSubmitMulti}
            disabled={selected.size === 0}
          >
            Submit ({selected.size})
          </button>
        )}
        <button
          className="question-block-other-toggle"
          onClick={() => setShowOther(!showOther)}
        >
          Other...
        </button>
      </div>

      {showOther && (
        <div className="question-block-other-input">
          <input
            type="text"
            value={otherText}
            onChange={(e) => setOtherText(e.target.value)}
            placeholder="Type your response..."
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                handleSendOther();
              }
            }}
            autoFocus
          />
          <button
            className="question-block-other-send"
            onClick={handleSendOther}
          >
            Send
          </button>
        </div>
      )}

      {sendError && (
        <div className="choice-send-error" onClick={handleRetry}>
          Failed to send — tap to retry
        </div>
      )}
    </div>
  );
}

// Answer data for multi-question flow
export interface AnswerData {
  text: string;
  indices: number[];
  otherText?: string;
}

interface MultiQuestionFlowProps {
  questions: Question[];
  onSelectOption: (label: string) => void | Promise<boolean>;
  onSelectChoice?: (choice: ChoiceData) => Promise<boolean>;
}

export function MultiQuestionFlow({ questions, onSelectOption, onSelectChoice }: MultiQuestionFlowProps) {
  const [step, setStep] = useState(0);
  const [answers, setAnswers] = useState<Map<number, AnswerData>>(new Map());
  const [reviewing, setReviewing] = useState(false);
  const total = questions.length;

  const handleAnswer = useCallback((questionIdx: number, answer: AnswerData) => {
    setAnswers(prev => {
      const next = new Map(prev);
      next.set(questionIdx, answer);
      return next;
    });
  }, []);

  const handleNext = useCallback(() => {
    if (step < total - 1) {
      setStep(step + 1);
    } else {
      setReviewing(true);
    }
  }, [step, total]);

  const handleBack = useCallback(() => {
    if (reviewing) {
      setReviewing(false);
    } else if (step > 0) {
      setStep(step - 1);
    }
  }, [step, reviewing]);

  const handleEditFromReview = useCallback((idx: number) => {
    setReviewing(false);
    setStep(idx);
  }, []);

  const handleSubmitAll = useCallback(async () => {
    for (let i = 0; i < total; i++) {
      const answer = answers.get(i);
      const q = questions[i];
      if (onSelectChoice && answer) {
        await onSelectChoice({
          selectedIndices: answer.indices,
          optionCount: q.options.length,
          multiSelect: q.multiSelect,
          otherText: answer.otherText,
        });
      } else {
        await onSelectOption(answer?.text || '');
      }
      if (i < total - 1) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
  }, [answers, total, questions, onSelectOption, onSelectChoice]);

  if (reviewing) {
    return (
      <div className="multi-question-flow">
        <div className="multi-question-step">Review answers</div>
        <div className="multi-question-review">
          {questions.map((q, i) => (
            <div key={i} className="multi-question-review-item">
              <span>
                <span className="review-question">{q.header || q.question}: </span>
                <span className="review-answer">{answers.get(i)?.text || '(no answer)'}</span>
              </span>
              <button className="review-edit" onClick={() => handleEditFromReview(i)}>Edit</button>
            </div>
          ))}
        </div>
        <div className="multi-question-nav">
          <button onClick={handleBack}>Back</button>
          <button
            className="multi-question-submit"
            onClick={handleSubmitAll}
            disabled={answers.size < total}
          >
            Submit All
          </button>
        </div>
      </div>
    );
  }

  const currentQ = questions[step];
  const currentAnswer = answers.get(step);

  return (
    <div className="multi-question-flow">
      <div className="multi-question-progress">
        <span className="multi-question-step">Question {step + 1} of {total}</span>
        <div className="multi-question-dots">
          {Array.from({ length: total }, (_, i) => (
            <span
              key={i}
              className={`mq-dot ${i === step ? 'active' : ''} ${answers.has(i) ? 'answered' : ''}`}
              onClick={() => { if (answers.has(i)) { setReviewing(false); setStep(i); } }}
            />
          ))}
        </div>
      </div>
      <QuestionBlockSingle
        question={currentQ}
        selectedAnswer={currentAnswer}
        onAnswer={(answer) => handleAnswer(step, answer)}
      />

      <div className="multi-question-nav">
        <button onClick={handleBack} disabled={step === 0}>Back</button>
        <button onClick={handleNext} disabled={!currentAnswer}>
          {step === total - 1 ? 'Review' : 'Next'}
        </button>
      </div>
    </div>
  );
}

// Single-question collector for multi-question flow (doesn't submit immediately)
interface QuestionBlockSingleProps {
  question: Question;
  selectedAnswer?: AnswerData;
  onAnswer: (answer: AnswerData) => void;
}

function QuestionBlockSingle({ question, selectedAnswer, onAnswer }: QuestionBlockSingleProps) {
  const [selected, setSelected] = useState<Set<number>>(() => {
    if (!selectedAnswer) return new Set();
    return new Set(selectedAnswer.indices);
  });
  const [showOther, setShowOther] = useState(false);
  const [otherText, setOtherText] = useState('');

  const handleOptionClick = useCallback((idx: number) => {
    if (question.multiSelect) {
      setSelected(prev => {
        const next = new Set(prev);
        if (next.has(idx)) next.delete(idx);
        else next.add(idx);
        const sortedIndices = Array.from(next).sort((a, b) => a - b);
        const labels = sortedIndices.map(i => question.options[i].label);
        if (sortedIndices.length > 0) {
          onAnswer({ text: labels.join(', '), indices: sortedIndices });
        }
        return next;
      });
    } else {
      setSelected(new Set([idx]));
      onAnswer({ text: question.options[idx].label, indices: [idx] });
    }
  }, [question.multiSelect, question.options, onAnswer]);

  const handleSendOther = useCallback(() => {
    const trimmed = otherText.trim();
    if (!trimmed) return;
    onAnswer({ text: trimmed, indices: [], otherText: trimmed });
    setSelected(new Set());
  }, [otherText, onAnswer]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      const num = parseInt(e.key);
      if (num >= 1 && num <= question.options.length) {
        e.preventDefault();
        handleOptionClick(num - 1);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [question.options, handleOptionClick]);

  const showDescriptions = question.options.some(o => o.description);

  return (
    <div className="question-block">
      {question.header && <div className="question-block-header">{question.header}</div>}
      {question.question && <div className="question-block-text">{question.question}</div>}
      <div className={`question-block-options ${showDescriptions ? 'with-descriptions' : ''}`}>
        {question.options.map((opt, idx) => (
          <button
            key={opt.label}
            className={`msg-option-btn ${selected.has(idx) ? 'selected' : ''} ${showDescriptions ? 'with-desc' : ''}`}
            onClick={() => handleOptionClick(idx)}
            title={opt.description}
          >
            <span className="option-key-hint">{idx + 1}</span>
            <span className="option-label">{opt.label}</span>
            {showDescriptions && opt.description && (
              <span className="option-description">{opt.description}</span>
            )}
          </button>
        ))}
      </div>
      <div className="question-block-actions">
        <button className="question-block-other-toggle" onClick={() => setShowOther(!showOther)}>
          Other...
        </button>
      </div>
      {showOther && (
        <div className="question-block-other-input">
          <input
            type="text"
            value={otherText}
            onChange={e => setOtherText(e.target.value)}
            placeholder="Type your response..."
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); handleSendOther(); } }}
            autoFocus
          />
          <button className="question-block-other-send" onClick={handleSendOther}>Send</button>
        </div>
      )}
    </div>
  );
}
