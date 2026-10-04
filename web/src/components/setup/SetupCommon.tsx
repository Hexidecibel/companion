import { useCallback, useState, type ReactNode } from 'react';
import { copyToClipboard } from '../../utils/clipboard';
import type { CheckStatus } from '../../types/setup';

export function IconCheck({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M3.5 8.5l3 3 6-7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function IconSkip({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M4 8h8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

export function IconWarn({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M8 4.5v4.2M8 11.2v.3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

export function IconCross({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M5 5l6 6M11 5l-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

export function IconFolder({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M1.75 4.25c0-.69.56-1.25 1.25-1.25h3.1l1.4 1.5H13c.69 0 1.25.56 1.25 1.25v6c0 .69-.56 1.25-1.25 1.25H3c-.69 0-1.25-.56-1.25-1.25v-7.5z"
        stroke="currentColor"
        strokeWidth="1.3"
      />
    </svg>
  );
}

export function StatusIcon({ status }: { status: CheckStatus | 'pending' }) {
  if (status === 'pending') return <span className="sw-status sw-status--pending"><span className="sw-spinner" /></span>;
  return (
    <span className={`sw-status sw-status--${status}`} aria-label={status}>
      {status === 'ok' ? <IconCheck /> : status === 'warn' ? <IconWarn /> : <IconCross />}
    </span>
  );
}

/** A command the user runs in a terminal, with a copy button. */
export function CopyCommand({ command, label }: { command: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = useCallback(() => {
    void copyToClipboard(command).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    });
  }, [command]);
  return (
    <div className="sw-cmd">
      {label && <div className="sw-cmd__label">{label}</div>}
      <div className="sw-cmd__row">
        <code className="sw-cmd__code">{command}</code>
        <button type="button" className="sw-cmd__copy" onClick={copy} aria-label={`Copy: ${command}`}>
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
    </div>
  );
}

export function Notice({ tone = 'info', children }: { tone?: 'info' | 'ok' | 'warn' | 'error'; children: ReactNode }) {
  return <div className={`sw-notice sw-notice--${tone}`}>{children}</div>;
}

export function Spinner() {
  return <span className="sw-spinner" aria-hidden="true" />;
}
