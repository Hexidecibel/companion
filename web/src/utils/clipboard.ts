/**
 * Copy text to clipboard with fallback for non-HTTPS origins
 * and environments where navigator.clipboard is unavailable.
 */
function fallbackCopy(text: string): void {
  const ta = document.createElement('textarea');
  ta.value = text;
  document.body.appendChild(ta);
  ta.select();
  document.execCommand('copy');
  document.body.removeChild(ta);
}

export function copyToClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text).catch(() => {
      fallbackCopy(text);
    });
  }
  fallbackCopy(text);
  return Promise.resolve();
}
