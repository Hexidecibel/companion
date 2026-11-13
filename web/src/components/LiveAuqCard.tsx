/**
 * The chat card for a live Claude Code AskUserQuestion box (Question.live).
 *
 * It mirrors what the terminal shows right now: which question of how many,
 * the checks already made, the text typed into "Other", the review screen.
 * Every action goes to the daemon's step-by-step driver with the signature of
 * the box the user saw, so a box that changed meanwhile is refused instead of
 * answered wrongly. Nothing is ever submitted without an explicit tap.
 */
import { useEffect, useState } from 'react';
import type { Question } from '../types';
import type { ChoiceData } from '../services/sendChoice';

interface LiveAuqCardProps {
  question: Question;
  onSelectChoice: (choice: ChoiceData) => Promise<boolean>;
}

const DESC_CLAMP = 140;

function OptionDescription({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  if (!text) return null;
  const long = text.length > DESC_CLAMP;
  return (
    <span className="live-auq-desc">
      {long && !open ? `${text.slice(0, DESC_CLAMP).trimEnd()}...` : text}
      {long && (
        <span
          role="button"
          tabIndex={0}
          className="live-auq-more"
          onClick={(e) => {
            e.stopPropagation();
            setOpen((v) => !v);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              e.stopPropagation();
              setOpen((v) => !v);
            }
          }}
        >
          {open ? ' show less' : ' show more'}
        </span>
      )}
    </span>
  );
}

export function LiveAuqCard({ question, onSelectChoice }: LiveAuqCardProps) {
  const live = question.live!;
  const options = question.options ?? [];
  const multi = !!question.multiSelect;
  const stateKey = `${live.signature}|${live.screen}|${options.map((o) => (o.selected ? 1 : 0)).join('')}|${live.otherText ?? ''}|${live.otherChecked ? 1 : 0}`;

  const [checked, setChecked] = useState<Set<number>>(
    () => new Set(options.flatMap((o, i) => (o.selected ? [i] : [])))
  );
  const [otherOn, setOtherOn] = useState(!!live.otherChecked);
  const [otherText, setOtherText] = useState(live.otherText ?? '');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  // The terminal moved on (or the user checked something there): start from what it shows.
  useEffect(() => {
    setChecked(new Set(options.flatMap((o, i) => (o.selected ? [i] : []))));
    setOtherOn(!!live.otherChecked);
    setOtherText(live.otherText ?? '');
    setFailed(false);
    setBusy(false);
  }, [stateKey]);

  const send = async (choice: Omit<ChoiceData, 'expectSignature'>) => {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    let ok = false;
    try {
      ok = await onSelectChoice({ ...choice, expectSignature: live.signature });
    } catch {
      ok = false;
    }
    // On success the card is replaced by the terminal's next state; keep it
    // disabled until then so a double tap cannot answer the next question.
    if (!ok) {
      setBusy(false);
      setFailed(true);
    }
  };

  const count = live.questionCount ?? 0;
  const index = live.questionIndex ?? 0;
  const canBack = count > 1 && index > 0;
  const back = canBack ? (
    <button
      type="button"
      className="live-auq-nav"
      disabled={busy}
      onClick={() => send({ selectedIndices: [], optionCount: 0, multiSelect: false, navigate: 'back' })}
    >
      Back
    </button>
  ) : null;

  const tabs =
    live.tabs && live.tabs.length > 1 ? (
      <div className="live-auq-tabs" aria-label="Questions">
        {live.tabs.map((t, i) => (
          <span
            key={i}
            className={`live-auq-tab${i === index && live.screen === 'question' ? ' active' : ''}${t.answered ? ' answered' : ''}`}
          >
            {t.answered ? '✓ ' : ''}
            {t.label}
          </span>
        ))}
      </div>
    ) : null;

  const errorLine = failed ? (
    <div className="live-auq-error" role="alert">
      That did not go through: the terminal changed or did not react. The card shows what is on screen now.
    </div>
  ) : null;

  if (live.screen === 'review') {
    return (
      <div className="live-auq-card" data-testid="live-auq-card">
        {tabs}
        <div className="live-auq-title">Review your answers</div>
        <ul className="live-auq-review">
          {(live.review ?? []).map((r, i) => (
            <li key={i}>
              <span className="live-auq-review-q">{r.question}</span>
              <span className="live-auq-review-a">{r.answer}</span>
            </li>
          ))}
        </ul>
        {live.incomplete && <div className="live-auq-warn">Not every question has an answer yet.</div>}
        {errorLine}
        <div className="live-auq-actions">
          {back}
          <button
            type="button"
            className="live-auq-nav"
            disabled={busy}
            onClick={() => send({ selectedIndices: [1], optionCount: 2, multiSelect: false })}
          >
            Cancel
          </button>
          <button
            type="button"
            className="live-auq-primary"
            disabled={busy}
            onClick={() => send({ selectedIndices: [0], optionCount: 2, multiSelect: false, submit: true })}
          >
            Submit answers
          </button>
        </div>
      </div>
    );
  }

  const progress = count > 1 ? `Question ${index + 1} of ${count}` : null;
  const lastQuestion = count <= 1 || index >= count - 1;
  const submitLabel = live.submitRow === 'Submit' || (!live.submitRow && lastQuestion) ? 'Submit' : 'Next';

  const pick = (i: number) => {
    if (multi) {
      setChecked((prev) => {
        const next = new Set(prev);
        if (next.has(i)) next.delete(i);
        else next.add(i);
        return next;
      });
      return;
    }
    send({
      selectedIndices: [i],
      optionCount: options.length,
      multiSelect: false,
      selectedLabels: [options[i].label],
    });
  };

  const sendMulti = () => {
    const indices = [...checked].sort((a, b) => a - b);
    const text = otherOn ? otherText.trim() : '';
    send({
      selectedIndices: indices,
      optionCount: options.length,
      multiSelect: true,
      selectedLabels: indices.map((i) => options[i].label),
      ...(text ? { otherText: text } : {}),
      ...(submitLabel === 'Submit' ? { submit: true } : {}),
    });
  };

  return (
    <div className="live-auq-card" data-testid="live-auq-card">
      {tabs}
      {(progress || question.header) && (
        <div className="live-auq-header">
          {question.header && <span className="live-auq-chip">{question.header}</span>}
          {progress && <span className="live-auq-progress">{progress}</span>}
        </div>
      )}
      <div className="live-auq-title">{question.question}</div>
      {multi && <div className="live-auq-hint">Pick any that apply, then {submitLabel}.</div>}
      <div className="live-auq-options">
        {options.map((o, i) => (
          <button
            key={`${i}-${o.label}`}
            type="button"
            className={`live-auq-option${multi && checked.has(i) ? ' checked' : ''}`}
            role={multi ? 'checkbox' : undefined}
            aria-checked={multi ? checked.has(i) : undefined}
            disabled={busy}
            onClick={() => pick(i)}
          >
            <span className="live-auq-mark" aria-hidden="true">
              {multi ? (checked.has(i) ? '☑' : '☐') : i + 1}
            </span>
            <span className="live-auq-text">
              <span className="live-auq-label">{o.label}</span>
              <OptionDescription text={o.description} />
            </span>
          </button>
        ))}
      </div>
      {live.preview && <div className="live-auq-hint">Each option has a preview in the terminal.</div>}
      {live.allowOther && (
        <div className="live-auq-other">
          {multi && (
            <label className="live-auq-other-check">
              <input
                type="checkbox"
                checked={otherOn}
                disabled={busy}
                onChange={(e) => setOtherOn(e.target.checked)}
              />
              Other
            </label>
          )}
          <input
            type="text"
            className="live-auq-other-input"
            placeholder={multi ? 'Something else...' : 'Or type your own answer...'}
            value={otherText}
            disabled={busy}
            onChange={(e) => {
              setOtherText(e.target.value);
              if (multi && e.target.value.trim()) setOtherOn(true);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !multi && otherText.trim()) {
                send({ selectedIndices: [], optionCount: options.length, multiSelect: false, otherText: otherText.trim() });
              }
            }}
          />
          {!multi && (
            <button
              type="button"
              className="live-auq-nav"
              disabled={busy || !otherText.trim()}
              onClick={() =>
                send({ selectedIndices: [], optionCount: options.length, multiSelect: false, otherText: otherText.trim() })
              }
            >
              Send
            </button>
          )}
        </div>
      )}
      {errorLine}
      {(back || multi) && (
        <div className="live-auq-actions">
          {back}
          {multi && (
            <button
              type="button"
              className="live-auq-primary"
              disabled={busy || (checked.size === 0 && !(otherOn && otherText.trim()))}
              onClick={sendMulti}
            >
              {submitLabel}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
