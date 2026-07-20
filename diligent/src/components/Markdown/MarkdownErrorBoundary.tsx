import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  /** Raw markdown source — shown verbatim if rendering throws. */
  fallbackText?: string;
}

interface State {
  error: Error | null;
}

/**
 * Catches errors thrown by ReactMarkdown / Mermaid / shiki during streaming
 * partial markdown. Without this an uncaught commit-phase error unmounts
 * the entire React tree — which previously manifested as "the app
 * disappeared mid-stream but is still in the taskbar."
 *
 * When an error is caught we show the raw text so the user still gets the
 * content (just unstyled), plus a small error footer.
 */
export class MarkdownErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // eslint-disable-next-line no-console
    console.error("[markdown] render error", error, info.componentStack);
  }

  // Reset when new content arrives — streaming chunks frequently produce
  // transient malformed markdown that becomes valid a few tokens later.
  componentDidUpdate(prevProps: Props) {
    if (this.state.error && prevProps.fallbackText !== this.props.fallbackText) {
      this.setState({ error: null });
    }
  }

  render() {
    if (this.state.error) {
      return (
        <div className="space-y-2">
          {this.props.fallbackText && (
            <pre className="text-xs font-mono whitespace-pre-wrap text-foreground">
              {this.props.fallbackText}
            </pre>
          )}
          <p className="text-xs text-amber-600 dark:text-amber-400 italic">
            (raw text — formatting failed: {this.state.error.message})
          </p>
        </div>
      );
    }
    return this.props.children;
  }
}
