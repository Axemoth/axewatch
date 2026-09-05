import { Component, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  label?: string;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error("ErrorBoundary caught:", error);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="rounded-xl border border-rose-500/30 bg-rose-500/5 p-4">
          <p className="text-sm font-medium text-rose-400">
            {this.props.label ?? "This section"} failed to load
          </p>
          <p className="mt-1 font-mono text-xs text-zinc-500">{this.state.error.message}</p>
          <button
            type="button"
            onClick={() => this.setState({ error: null })}
            className="mt-3 rounded-lg border border-zinc-300 px-3 py-1.5 text-xs hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
          >
            Retry
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

