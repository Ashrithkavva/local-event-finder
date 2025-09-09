import React from 'react';

type Props = { children: React.ReactNode };
type State = { error: Error | null };

/**
 * Top-level error boundary. React requires class components for boundaries
 * (no hook equivalent for `componentDidCatch` yet). Renders a fallback UI
 * and logs to the console so dev tools surface it during development.
 */
export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // In a real app this would go to Sentry / Datadog / etc.
    // eslint-disable-next-line no-console
    console.error('Render error:', error, info);
  }

  reset = () => this.setState({ error: null });

  render() {
    if (this.state.error) {
      return (
        <main className="container">
          <h1 className="title">Something went wrong</h1>
          <p className="subtitle">
            The app hit an unexpected error and stopped rendering. Try again, or
            refresh the page.
          </p>
          <div className="error" style={{ marginTop: 16 }}>
            {this.state.error.message}
          </div>
          <button
            className="button"
            style={{ marginTop: 16 }}
            onClick={this.reset}
          >
            Try again
          </button>
        </main>
      );
    }
    return this.props.children;
  }
}
