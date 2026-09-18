/** Inline failure surface: one bad widget renders this, the rest of the home page stays intact.
 *  `compact` renders the panel-row form (one red row inside a panel, siblings unaffected). */
export function WidgetErrorCard({ title, message, compact }: { title?: string; message: string; compact?: boolean }) {
  if (compact) {
    return <div className="panel-row is-err mono">{title ? `${title}: ${message}` : message}</div>;
  }
  return (
    <div className="widget-card widget-error">
      <span className="widget-label">{title ?? "widget error"}</span>
      <p className="mono">{message}</p>
    </div>
  );
}
