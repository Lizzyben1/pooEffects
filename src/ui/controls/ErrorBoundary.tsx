import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * Contains a rendering failure to the part of the UI it happened in. Without a boundary React unmounts
 * the whole app on any render error, and because the last session is restored on reload, a document
 * that trips a bug would keep the app blank across reloads.
 */
export class ErrorBoundary extends Component<
  { children: ReactNode; fallback: (error: Error, retry: () => void) => ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: unknown): { error: Error } {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[ui] render error', error, info.componentStack);
  }

  retry = (): void => this.setState({ error: null });

  render(): ReactNode {
    return this.state.error ? this.props.fallback(this.state.error, this.retry) : this.props.children;
  }
}
