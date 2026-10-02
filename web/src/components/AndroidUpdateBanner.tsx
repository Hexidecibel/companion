import { useState } from 'react';
import { useAndroidUpdater } from '../hooks/useAndroidUpdater';

const DISMISS_KEY = 'android_update_dismissed';

function readDismissed(): number | null {
  try {
    const v = Number(localStorage.getItem(DISMISS_KEY));
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}

/**
 * "Update available (1.0.N)" pill (Android app only). One tap downloads and
 * verifies the APK, then the system installer asks the user to confirm.
 * Dismissing hides it until a newer build appears.
 */
export function AndroidUpdateBanner() {
  const { enabled, state, install, openSettings } = useAndroidUpdater();
  const [dismissed, setDismissed] = useState<number | null>(readDismissed);
  const entry = state.available;
  if (!enabled || !entry) return null;
  const busy = state.phase === 'downloading';
  if (dismissed !== null && dismissed >= entry.versionCode && !busy) return null;

  const dismiss = () => {
    setDismissed(entry.versionCode);
    try {
      localStorage.setItem(DISMISS_KEY, String(entry.versionCode));
    } catch {
      // Private storage: dismissal lasts this session only.
    }
  };

  let text = `Update available (${entry.versionName})`;
  let action: { label: string; run: () => void } | null = { label: 'Update', run: () => void install() };
  if (state.phase === 'downloading') {
    text = state.progress === null ? 'Downloading update...' : `Downloading update... ${Math.round(state.progress * 100)}%`;
    action = null;
  } else if (state.phase === 'needs_permission') {
    text = 'Allow Companion to install apps, then tap Install.';
    action = { label: 'Open settings', run: () => void openSettings() };
  } else if (state.phase === 'installer') {
    text = 'Confirm the update in the installer.';
    action = { label: 'Install', run: () => void install() };
  } else if (state.phase === 'error') {
    text = `Update failed: ${state.error ?? 'unknown error'}`;
    action = { label: 'Retry', run: () => void install() };
  }

  return (
    <div className="update-banner update-banner--android" role="status">
      <span className="update-banner-text">{text}</span>
      {action && (
        <button className="update-banner-action" onClick={action.run}>
          {action.label}
        </button>
      )}
      {state.phase === 'needs_permission' && (
        <button className="update-banner-action update-banner-action--secondary" onClick={() => void install()}>
          Install
        </button>
      )}
      {!busy && (
        <button className="update-banner-dismiss" aria-label="Dismiss" title="Later" onClick={dismiss}>
          &times;
        </button>
      )}
    </div>
  );
}
