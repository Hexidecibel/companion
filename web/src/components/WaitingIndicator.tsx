import { SessionStatus } from '../types';

interface WaitingIndicatorProps {
  status: SessionStatus | null;
}

export function WaitingIndicator({ status }: WaitingIndicatorProps) {
  if (!status) return null;

  if (status.isWaitingForInput) {
    return (
      <div className="waiting-banner waiting-banner-amber">
        <span className="waiting-dot amber" />
        <span>Waiting for input</span>
      </div>
    );
  }

  if (status.currentActivity) {
    return (
      <div className="waiting-banner waiting-banner-blue">
        <div className="spinner small" />
        <span>{status.currentActivity}</span>
      </div>
    );
  }

  return null;
}
