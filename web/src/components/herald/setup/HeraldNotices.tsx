import { useHeraldSetupCtx } from '../../../context/HeraldContext';
import { TIPS, tipsStore, useTips } from '../../../services/heraldSetup/tips';
import { IconX } from '../heraldIcons';

/**
 * Setup notices above the composer: an audio-change profile suggestion, the
 * note after an automatic switch, and one-time tips (one at a time).
 */
export function HeraldNotices() {
  const setup = useHeraldSetupCtx();
  const { queue } = useTips();
  const tip = queue[0] ? TIPS[queue[0]] : null;

  if (setup.suggestion) {
    return (
      <div className="hn hn--suggest" role="status">
        <span className="hn__dot" aria-hidden="true" />
        <span className="hn__text">{setup.suggestion.message}</span>
        <span className="hn__actions">
          <button type="button" className="hn__btn hn__btn--primary" onClick={setup.acceptSuggestion}>Switch</button>
          <button type="button" className="hn__btn" onClick={setup.dismissSuggestion}>Not now</button>
        </span>
      </div>
    );
  }
  if (setup.autoNote) {
    return (
      <div className="hn hn--auto" role="status">
        <span className="hn__dot" aria-hidden="true" />
        <span className="hn__text">{setup.autoNote}</span>
      </div>
    );
  }
  if (tip) {
    return (
      <div className="hn hn--tip" role="note">
        <span className="hn__body">
          <span className="hn__title">{tip.title}</span>
          <span className="hn__text">{tip.body}</span>
        </span>
        <button type="button" className="herald-icon-btn herald-icon-btn--sm" onClick={() => tipsStore.dismiss()} aria-label="Dismiss tip">
          <IconX size={13} />
        </button>
      </div>
    );
  }
  return null;
}
