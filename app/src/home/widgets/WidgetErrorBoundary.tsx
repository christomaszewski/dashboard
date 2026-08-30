import { Component, type ReactNode } from "react";
import { WidgetErrorCard } from "./WidgetErrorCard";

/**
 * Second containment layer: config validation catches malformed widgets before render, this catches
 * RUNTIME crashes inside a widget — both degrade to the same inline card, never a blank page.
 */
export class WidgetErrorBoundary extends Component<
  { label?: string; children: ReactNode },
  { error: string | null }
> {
  state = { error: null as string | null };

  static getDerivedStateFromError(e: unknown) {
    return { error: e instanceof Error ? e.message : String(e) };
  }

  render() {
    if (this.state.error !== null) {
      return <WidgetErrorCard title={this.props.label} message={`widget crashed: ${this.state.error}`} />;
    }
    return this.props.children;
  }
}
