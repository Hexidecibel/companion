import { Component, ErrorInfo, ReactNode } from 'react';

interface Props {
  children: ReactNode;
  name?: string;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ComponentErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error(`ComponentErrorBoundary [${this.props.name || 'unknown'}]:`, error, errorInfo);
  }

  private retry() {
    this.setState({ hasError: false, error: null });
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      const { error } = this.state;
      const label = this.props.name || 'Component';

      return (
        <div style={{
          backgroundColor: '#1f2937',
          border: '1px solid #ef4444',
          borderRadius: '8px',
          padding: '16px',
          margin: '8px',
          color: '#f3f4f6',
          fontSize: '13px',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
            <span style={{
              backgroundColor: '#ef4444',
              color: '#fff',
              borderRadius: '4px',
              padding: '1px 6px',
              fontSize: '11px',
              fontWeight: 600,
              textTransform: 'uppercase',
            }}>
              Error
            </span>
            <span style={{ color: '#9ca3af', fontSize: '12px' }}>{label}</span>
          </div>
          <p style={{ margin: '0 0 12px 0', color: '#f3f4f6', wordBreak: 'break-word' }}>
            {error?.message || 'An unexpected error occurred'}
          </p>
          <button
            onClick={() => this.retry()}
            style={{
              backgroundColor: '#374151',
              color: '#f3f4f6',
              border: '1px solid #4b5563',
              borderRadius: '6px',
              padding: '6px 16px',
              cursor: 'pointer',
              fontSize: '12px',
            }}
          >
            Retry
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
