/**
 * dashboard-client/src/components/ErrorBoundary.tsx — React error boundary.
 *
 * Catches render errors anywhere in the child tree and shows a fallback
 * with a reload button. Re-throws are prevented; recovery is via reload.
 */

import React, { type ReactNode } from 'react';

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  override componentDidCatch(error: Error, info: React.ErrorInfo): void {
    // Keep the error visible in the console for debugging; no network reporting
    // (PREVENT-PI-004 — dashboard is fully local).
    console.error('[dashboard] render error:', error, info.componentStack);
  }

  private handleReload = (): void => {
    window.location.reload();
  };

  override render(): ReactNode {
    if (this.state.hasError) {
      return (
        <div className="error-fallback">
          <h2>Something went wrong</h2>
          <p>{this.state.error?.message ?? 'Unknown render error'}</p>
          <button type="button" onClick={this.handleReload}>Reload dashboard</button>
        </div>
      );
    }
    return this.props.children;
  }
}
