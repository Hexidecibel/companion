import { useState } from 'react';

interface FetchErrorBannerProps {
  message: string;
  onDismiss?: () => void;
  onRetry?: () => void;
}

export function FetchErrorBanner({ message, onDismiss, onRetry }: FetchErrorBannerProps) {
  const [dismissed, setDismissed] = useState(false);

  if (dismissed) return null;

  return (
    <div className="fetch-error-banner">
      <span className="fetch-error-banner-text">{message}</span>
      {onRetry && (
        <button className="fetch-error-banner-btn" onClick={onRetry}>
          Retry
        </button>
      )}
      <button
        className="fetch-error-banner-btn"
        onClick={() => {
          setDismissed(true);
          onDismiss?.();
        }}
      >
        Dismiss
      </button>
    </div>
  );
}
