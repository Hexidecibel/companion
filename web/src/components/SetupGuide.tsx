import { useState, useCallback } from 'react';

const INSTALL_SCRIPT = `git clone https://github.com/Hexidecibel/companion.git
cd companion/daemon
bash scripts/install.sh`;

interface SetupGuideProps {
  onAddServer?: () => void;
}

export function SetupGuide({ onAddServer }: SetupGuideProps) {
  const [copied, setCopied] = useState<string | null>(null);

  const copyText = useCallback((text: string, label: string) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(label);
      setTimeout(() => setCopied(null), 2000);
    }).catch(() => {
      // Fallback for older browsers
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      setCopied(label);
      setTimeout(() => setCopied(null), 2000);
    });
  }, []);

  return (
    <div className="setup-guide">
      <h1 className="setup-guide-title">Get Started with Companion</h1>
      <p className="setup-guide-subtitle">
        Set up the daemon on your server to connect from here.
      </p>

      <div className="setup-step">
        <p className="setup-step-title">
          <span className="setup-step-number">1</span>
          Install the Daemon
        </p>
        <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 8 }}>
          Run these commands on your server (macOS, Ubuntu, Fedora, Arch):
        </p>
        <div className="setup-code-block">
          {INSTALL_SCRIPT}
          <button
            className="setup-copy-btn"
            onClick={() => copyText(INSTALL_SCRIPT, 'install')}
          >
            {copied === 'install' ? 'Copied!' : 'Copy'}
          </button>
        </div>
      </div>

      <div className="setup-step">
        <p className="setup-step-title">
          <span className="setup-step-number">2</span>
          Save Your Auth Token
        </p>
        <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 8 }}>
          The installer generates a token and shows it at the end. You can also find it in:
        </p>
        <div className="setup-code-block">
          cat /etc/companion/config.json | grep token
          <button
            className="setup-copy-btn"
            onClick={() => copyText('cat /etc/companion/config.json | grep token', 'token')}
          >
            {copied === 'token' ? 'Copied!' : 'Copy'}
          </button>
        </div>
      </div>

      <div className="setup-step">
        <p className="setup-step-title">
          <span className="setup-step-number">3</span>
          Add Your Server
        </p>
        <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 8 }}>
          Enter your server's IP address or hostname and the auth token.
        </p>
        {onAddServer && (
          <button className="btn-primary" onClick={onAddServer} style={{ maxWidth: 200 }}>
            Add Server
          </button>
        )}
      </div>

      <div className="setup-step">
        <p className="setup-step-title" style={{ fontSize: 14, color: 'var(--text-muted)' }}>
          What gets installed
        </p>
        <ul style={{ fontSize: 13, color: 'var(--text-secondary)', paddingLeft: 20, lineHeight: 1.8 }}>
          <li>Node.js 20 (if not present)</li>
          <li>tmux (for coding sessions)</li>
          <li>Daemon with auto-start service</li>
          <li>TLS certificates (auto-generated)</li>
        </ul>
      </div>
    </div>
  );
}
