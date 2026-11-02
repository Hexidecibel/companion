import { useState } from 'react';
import type { Question } from '../types';
import type { ChoiceData } from './QuestionBlock';

interface TrustPromptCardProps {
  question: Question;
  onAnswer: (choice: ChoiceData) => Promise<boolean>;
}

type CardState =
  | { step: 'ask'; error?: string }
  | { step: 'sending'; index: number }
  | { step: 'answered'; index: number };

const ERROR_TEXT = 'Your answer did not reach the session. Try again, or answer it in the terminal.';

/**
 * An agent's start-up prompt ("Trust this folder?", Claude's bypass warning) in
 * the chat. Only the user answers these. The daemon always sends yes as option 0
 * and no as option 1, and a question of "title\nfolder". The card leaves when the
 * prompt leaves the pane (the next get_highlights no longer carries it); after
 * "No" the agent exits, so the card stays and says what happened.
 */
export function TrustPromptCard({ question, onAnswer }: TrustPromptCardProps) {
  const [state, setState] = useState<CardState>({ step: 'ask' });
  const [title, ...rest] = question.question.split('\n');
  const folder = rest.join('').trim();
  const [yes, no] = question.options;

  const answer = async (index: number) => {
    setState({ step: 'sending', index });
    let ok = false;
    try {
      ok = await onAnswer({
        selectedIndices: [index],
        optionCount: question.options.length,
        multiSelect: false,
        promptKind: 'trust',
      });
    } catch {
      ok = false;
    }
    setState(ok ? { step: 'answered', index } : { step: 'ask', error: ERROR_TEXT });
  };

  const sending = state.step === 'sending';
  const agent = question.header || 'The agent';

  return (
    <div className="question-block trust-card" role="group" aria-label={title}>
      <div className="trust-card-agent">{agent} is waiting on you</div>
      <div className="trust-card-title">{title}</div>
      {folder && <div className="trust-card-folder">{folder}</div>}

      {state.step === 'answered' ? (
        <div className="trust-card-result" role="status">
          {state.index === 0 ? 'Answered. Starting...' : no?.description}
        </div>
      ) : (
        <>
          {yes?.description && <div className="trust-card-text">{yes.description}.</div>}
          <div className="trust-card-actions">
            <button
              type="button"
              className="trust-card-btn trust-card-btn-yes"
              disabled={sending}
              onClick={() => answer(0)}
            >
              {sending && state.index === 0 ? 'Sending...' : yes?.label}
            </button>
            <button
              type="button"
              className="trust-card-btn trust-card-btn-no"
              disabled={sending}
              onClick={() => answer(1)}
            >
              {sending && state.index === 1 ? 'Sending...' : no?.label}
            </button>
          </div>
          {no?.description && <div className="trust-card-hint">No: {no.description}.</div>}
          {state.step === 'ask' && state.error && (
            <div className="trust-card-error" role="alert">
              {state.error}
            </div>
          )}
        </>
      )}
    </div>
  );
}
