import { Component, type ErrorInfo, type ReactNode } from "react";

// A render error in one panel must never unmount the page (the stage screen goes white). The panel shows one small note; the
// rest of the desk keeps running. `resetKey` clears the error when the data it depends on changes.
type Props = { name: string; children: ReactNode; resetKey?: unknown };
type State = { failed: boolean; message: string };

export class ErrorBoundary extends Component<Props, State> {
  state: State = { failed: false, message: "" };

  static getDerivedStateFromError(e: unknown): State {
    return { failed: true, message: e instanceof Error ? e.message : String(e) };
  }

  componentDidCatch(e: unknown, info: ErrorInfo): void {
    console.error(`desk panel "${this.props.name}" failed to render`, e, info.componentStack);
  }

  componentDidUpdate(prev: Props): void {
    if (this.state.failed && prev.resetKey !== this.props.resetKey) this.setState({ failed: false, message: "" });
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="panel-failed" role="alert" title={this.state.message}>
        This panel failed to render ({this.props.name}). The rest of the desk is still running.
      </div>
    );
  }
}
