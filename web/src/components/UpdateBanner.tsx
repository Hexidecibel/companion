import { useState } from 'react';
import { useAppUpdater } from '../hooks/useAppUpdater';

/**
 * Small "Update ready" pill (desktop app only). Shown once a newer build has
 * been downloaded and verified; one click installs and relaunches. Dismissing
 * hides it for that version (the tray item and install-on-quit remain).
 */
export function UpdateBanner() {
  const { status, installNow } = useAppUpdater();
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);
  const [failed, setFailed] = useState(false);

  if (!status || !status.version) return null;
  const ready = status.state === 'ready' || status.state === 'installing';
  if (!ready || dismissed === status.version) return null;

  const onInstall = async () => {
    setInstalling(true);
    setFailed(false);
    try {
      await installNow();
    } catch {
      setFailed(true);
      setInstalling(false);
    }
  };

  return (
    <div className="update-banner" role="status">
      <span className="update-banner-text">
        {failed ? 'Update failed to install' : `Update ${status.version} available`}
      </span>
      <button
        className="update-banner-action"
        onClick={onInstall}
        disabled={installing || status.state === 'installing'}
      >
        {installing || status.state === 'installing' ? 'Restarting...' : 'Restart to update'}
      </button>
      <button
        className="update-banner-dismiss"
        aria-label="Dismiss"
        title="Later (installs when you quit, if enabled in Settings)"
        onClick={() => setDismissed(status.version)}
      >
        &times;
      </button>
    </div>
  );
}
