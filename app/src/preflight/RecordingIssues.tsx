import { useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { RecordingAction } from "./recording";

/** Errors stay behind one small indicator; opening details never changes the strip's height. */
export function RecordingIssues({ action, issues, retry, disabled }: {
  action: RecordingAction;
  issues: { id: string; label: string; message: string }[];
  retry?: () => void;
  disabled: boolean;
}) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const close = () => { setOpen(false); trigger.current?.focus(); };
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      if (!trigger.current || !panel.current) return;
      const r = trigger.current.getBoundingClientRect();
      const p = panel.current.getBoundingClientRect();
      setPosition({
        left: Math.max(12, Math.min(r.right - p.width, window.innerWidth - p.width - 12)),
        top: Math.max(12, Math.min(r.bottom + p.height + 8 > window.innerHeight - 12
          ? r.top - p.height - 8 : r.bottom + 8, window.innerHeight - p.height - 12)),
      });
    };
    const outside = (e: PointerEvent) => {
      if (!trigger.current?.contains(e.target as Node) && !panel.current?.contains(e.target as Node)) setOpen(false);
    };
    const escape = (e: KeyboardEvent) => { if (e.key === "Escape") { setOpen(false); trigger.current?.focus(); } };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open, issues]);
  // Move keyboard focus into the nonmodal panel only on opening, not on each status update.
  useLayoutEffect(() => { if (open) panel.current?.focus(); }, [open]);

  return <>
    <button ref={trigger} className="preflight-recording-button preflight-recording-issue" aria-label="Recording issues"
      title="Recording command needs attention" aria-expanded={open} aria-controls={open ? id : undefined}
      aria-haspopup="dialog" onClick={() => setOpen(value => !value)}>
      <span aria-hidden="true">!</span>
    </button>
    {open && createPortal(<div ref={panel} id={id} tabIndex={-1} role="dialog" aria-label="Recording issues"
      className="health-tooltip preflight-recording-errors" style={position}>
      <div className="preflight-recording-errors-heading"><strong>{action === "start" ? "Start" : "Stop"} recording needs attention</strong>
        <button className="preflight-recording-button" aria-label="Close recording issues" onClick={close}>×</button>
      </div>
      <ul>{issues.map(issue => <li key={issue.id}><strong>{issue.label}</strong>: {issue.message}</li>)}</ul>
      {retry && <button className="btn small" disabled={disabled} onClick={retry}>Retry failed</button>}
    </div>, document.body)}
  </>;
}
