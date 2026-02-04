import { Component, ErrorInfo, ReactNode, CSSProperties } from 'react';

const GITHUB_REPO = 'Hexidecibel/companion';
const APP_VERSION = '0.1.0';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
      errorInfo: null,
    };
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    this.setState({ errorInfo });
    console.error('ErrorBoundary caught:', error, errorInfo);
  }

  private buildGitHubIssueUrl(): string {
    const { error, errorInfo } = this.state;
    const errorMessage = error?.message || 'Unknown error';

    const titleMessage =
      errorMessage.length > 80
        ? errorMessage.substring(0, 77) + '...'
        : errorMessage;
    const title = `Bug Report: ${titleMessage}`;

    const componentStack = errorInfo?.componentStack
      ? errorInfo.componentStack.trim().substring(0, 500)
      : 'N/A';

    const ua = navigator.userAgent;
    const platform = navigator.platform || 'Unknown';

    const body = `## Error
\`\`\`
${errorMessage}
\`\`\`

## Component Stack
\`\`\`
${componentStack}
\`\`\`

## Environment
- **App Version:** ${APP_VERSION}
- **Platform:** Web
- **Browser:** ${ua}
- **OS:** ${platform}
- **Client:** React / Vite

## Steps to Reproduce
1.
2.
3.

## Additional Context
<!-- Add any other context about the problem here -->
`;

    const params = new URLSearchParams({
      title,
      body,
      labels: 'bug',
    });

    return `https://github.com/${GITHUB_REPO}/issues/new?${params.toString()}`;
  }

  private openGitHubIssue() {
    const url = this.buildGitHubIssueUrl();
    window.open(url, '_blank', 'noopener,noreferrer');
  }

  private retry() {
    this.setState({
      hasError: false,
      error: null,
      errorInfo: null,
    });
  }

  render() {
    if (this.state.hasError) {
      const { error } = this.state;

      return (
        <div style={styles.container}>
          <div style={styles.content}>
            {/* Error icon */}
            <div style={styles.iconCircle}>
              <span style={styles.iconText}>!</span>
            </div>

            {/* Heading */}
            <h1 style={styles.heading}>Something went wrong</h1>
            <p style={styles.subheading}>
              The app encountered an unexpected error.
            </p>

            {/* Error message card */}
            <div style={styles.errorCard}>
              <span style={styles.errorLabel}>ERROR</span>
              <p style={styles.errorMessage}>
                {error?.message || 'Unknown error'}
              </p>
            </div>

            {/* Buttons */}
            <div style={styles.buttonContainer}>
              <button
                style={styles.reportButton}
                onClick={() => this.openGitHubIssue()}
                onMouseEnter={(e) => {
                  e.currentTarget.style.opacity = '0.85';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.opacity = '1';
                }}
              >
                Report Bug
              </button>
              <button
                style={styles.retryButton}
                onClick={() => this.retry()}
                onMouseEnter={(e) => {
                  e.currentTarget.style.opacity = '0.85';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.opacity = '1';
                }}
              >
                Try Again
              </button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

const styles: Record<string, CSSProperties> = {
  container: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: '100vh',
    backgroundColor: '#111827',
    padding: 24,
  },
  content: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    maxWidth: 480,
    width: '100%',
  },
  iconCircle: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: 'rgba(239, 68, 68, 0.15)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    border: '2px solid #ef4444',
    marginBottom: 24,
  },
  iconText: {
    color: '#ef4444',
    fontSize: 32,
    fontWeight: 700,
    lineHeight: '36px',
  },
  heading: {
    color: '#f3f4f6',
    fontSize: 22,
    fontWeight: 700,
    textAlign: 'center',
    margin: '0 0 8px 0',
  },
  subheading: {
    color: '#9ca3af',
    fontSize: 15,
    textAlign: 'center',
    margin: '0 0 24px 0',
  },
  errorCard: {
    width: '100%',
    backgroundColor: '#1f2937',
    borderRadius: 12,
    padding: 16,
    border: '1px solid #374151',
    marginBottom: 24,
    boxSizing: 'border-box',
  },
  errorLabel: {
    color: '#ef4444',
    fontSize: 11,
    fontWeight: 600,
    textTransform: 'uppercase',
    letterSpacing: '0.5px',
    display: 'block',
    marginBottom: 8,
  },
  errorMessage: {
    color: '#f3f4f6',
    fontSize: 14,
    lineHeight: '20px',
    fontFamily: "'Menlo', 'Monaco', 'Courier New', monospace",
    margin: 0,
    wordBreak: 'break-word',
  },
  buttonContainer: {
    width: '100%',
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
  },
  reportButton: {
    width: '100%',
    padding: '14px 0',
    borderRadius: 12,
    backgroundColor: '#3b82f6',
    color: '#ffffff',
    fontSize: 16,
    fontWeight: 600,
    border: 'none',
    cursor: 'pointer',
    transition: 'opacity 0.15s',
  },
  retryButton: {
    width: '100%',
    padding: '14px 0',
    borderRadius: 12,
    backgroundColor: '#10b981',
    color: '#ffffff',
    fontSize: 16,
    fontWeight: 600,
    border: 'none',
    cursor: 'pointer',
    transition: 'opacity 0.15s',
  },
};
