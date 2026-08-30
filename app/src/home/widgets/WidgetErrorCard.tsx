/** Inline failure card: one bad widget renders this, the rest of the home page stays intact. */
export function WidgetErrorCard({ title, message }: { title?: string; message: string }) {
  return (
    <div className="widget-card widget-error">
      <span className="widget-label">{title ?? "widget error"}</span>
      <p className="mono">{message}</p>
    </div>
  );
}
