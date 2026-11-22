import { Component, type ReactNode } from "react";

/**
 * Keeps a failing section of the diagnostics page (a chunk that didn't load, a check that
 * threw) to itself, so the rest of the page and its report still show.
 */
export class SectionBoundary extends Component<
  { readonly title: string; readonly children: ReactNode },
  { readonly error: string | null }
> {
  override state = { error: null as string | null };

  static getDerivedStateFromError(error: unknown) {
    return { error: String(error) };
  }

  override render() {
    if (this.state.error === null) return this.props.children;
    return (
      <section className="diag__section">
        <h2 className="diag__section-title">{this.props.title}</h2>
        <p className="diag__error" data-testid="section-error">
          This section couldn't load: {this.state.error}
        </p>
      </section>
    );
  }
}
