import { Component, ErrorInfo, ReactNode } from 'react';

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
        <div className="error-boundary-container">
          <div className="error-boundary-content">
            {/* Error icon */}
            <div className="error-boundary-icon">
              <span className="error-boundary-icon-text">!</span>
            </div>

            {/* Heading */}
            <h1 className="error-boundary-heading">Something went wrong</h1>
            <p className="error-boundary-subheading">
              The app encountered an unexpected error.
            </p>

            {/* Error message card */}
            <div className="error-boundary-card">
              <span className="error-boundary-label">ERROR</span>
              <p className="error-boundary-message">
                {error?.message || 'Unknown error'}
              </p>
            </div>

            {/* Buttons */}
            <div className="error-boundary-buttons">
              <button
                className="error-boundary-btn error-boundary-btn-report"
                onClick={() => this.openGitHubIssue()}
              >
                Report Bug
              </button>
              <button
                className="error-boundary-btn error-boundary-btn-retry"
                onClick={() => this.retry()}
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
