import React, { Component, type ReactNode, type ErrorInfo } from 'react';

interface ErrorBoundaryProps {
  children: ReactNode;
  fallbackTitle?: string;
  onReset?: () => void;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.error('ErrorBoundary caught an error:', error, errorInfo);
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null });
    if (this.props.onReset) {
      this.props.onReset();
    }
  };

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <div className="error-fallback-card" style={{ padding: 24, textAlign: 'center', margin: 'auto' }}>
          <div style={{ fontSize: '2rem', marginBottom: 12 }}>⚠️</div>
          <h3 style={{ fontSize: '1.1rem', fontWeight: 600, color: 'var(--claude-text)', marginBottom: 8 }}>
            {this.props.fallbackTitle || 'Something went wrong'}
          </h3>
          <p style={{ fontSize: '0.875rem', color: 'var(--claude-text-secondary)', marginBottom: 16, maxWidth: 360, margin: '0 auto 16px auto' }}>
            {this.state.error?.message || 'An unexpected error occurred while rendering this component.'}
          </p>
          <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
            <button
              type="button"
              className="btn-card-action btn-card-primary"
              onClick={this.handleReset}
            >
              Try Again
            </button>
            <button
              type="button"
              className="btn-card-action btn-card-secondary"
              onClick={() => window.location.reload()}
            >
              Reload
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
