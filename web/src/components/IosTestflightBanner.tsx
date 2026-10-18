import { useState } from 'react';
import { useIosTestflight } from '../hooks/useIosTestflight';

const DISMISS_KEY = 'ios_testflight_dismissed';

function readDismissed(): number | null {
  try {
    const v = Number(localStorage.getItem(DISMISS_KEY));
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}

/**
 * "Build N is on TestFlight" pill (iOS app only). iOS cannot self-update, so
 * the button opens TestFlight, where the user installs it (or turns on
 * Automatic Updates). Dismissing hides it until a newer build appears.
 */
export function IosTestflightBanner() {
  const { enabled, available, openTestflight } = useIosTestflight();
  const [dismissed, setDismissed] = useState<number | null>(readDismissed);
  if (!enabled || !available) return null;
  if (dismissed !== null && dismissed >= available.build) return null;

  const dismiss = () => {
    setDismissed(available.build);
    try {
      localStorage.setItem(DISMISS_KEY, String(available.build));
    } catch {
      // Private storage: dismissal lasts this session only.
    }
  };

  return (
    <div className="update-banner update-banner--ios" role="status">
      <span className="update-banner-text">Build {available.build} is on TestFlight</span>
      <button className="update-banner-action" onClick={() => void openTestflight()}>
        Open TestFlight
      </button>
      <button className="update-banner-dismiss" aria-label="Dismiss" title="Later" onClick={dismiss}>
        &times;
      </button>
    </div>
  );
}
