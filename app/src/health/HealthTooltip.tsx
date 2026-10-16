import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

/** Hover, keyboard focus, or tap for detail. A portal keeps it outside scrolling widget cards. */
export function HealthTooltip({ children, detail, className, label }: {
  children: ReactNode; detail: ReactNode; className: string; label?: string;
}) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const tip = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const pinned = useRef(false);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const cancelClose = () => clearTimeout(timer.current);
  const announce = () => document.dispatchEvent(new CustomEvent("health-tooltip-opened", { detail: id }));
  const show = () => { cancelClose(); announce(); setOpen(true); };
  const hide = () => {
    cancelClose();
    timer.current = setTimeout(() => {
      if (!pinned.current && document.activeElement !== trigger.current) setOpen(false);
    }, 120);
  };
  useEffect(() => () => clearTimeout(timer.current), []);
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      if (!trigger.current || !tip.current) return;
      const r = trigger.current.getBoundingClientRect();
      const t = tip.current.getBoundingClientRect();
      setPosition({
        left: Math.max(12, Math.min(r.left, window.innerWidth - t.width - 12)),
        top: Math.max(12, Math.min(r.bottom + 8 + t.height > window.innerHeight - 12
          ? r.top - t.height - 8 : r.bottom + 8, window.innerHeight - t.height - 12)),
      });
    };
    const close = () => { pinned.current = false; setOpen(false); };
    const otherTooltip = (e: Event) => { if ((e as CustomEvent<string>).detail !== id) close(); };
    const escape = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    const outside = (e: PointerEvent) => {
      if (!trigger.current?.contains(e.target as Node) && !tip.current?.contains(e.target as Node)) close();
    };
    place();
    window.addEventListener("resize", place);
    // Reposition on an ancestor scroll, but leave long tooltip content scrollable.
    const scroll = (e: Event) => { if (!tip.current?.contains(e.target as Node)) place(); };
    window.addEventListener("scroll", scroll, true);
    document.addEventListener("keydown", escape);
    document.addEventListener("pointerdown", outside);
    document.addEventListener("health-tooltip-opened", otherTooltip);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", scroll, true);
      document.removeEventListener("keydown", escape);
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("health-tooltip-opened", otherTooltip);
    };
  }, [open, detail, id]);
  return <>
    <button ref={trigger} type="button" className={className} aria-label={label}
      aria-describedby={open ? id : undefined} onMouseEnter={show} onMouseLeave={hide}
      onFocus={show} onBlur={() => { pinned.current = false; hide(); }}
      onClick={() => { pinned.current = !pinned.current; cancelClose(); if (pinned.current) announce(); setOpen(pinned.current); }}>
      {children}
    </button>
    {open && createPortal(<div ref={tip} id={id} role="tooltip" className="health-tooltip" style={position}
      onMouseEnter={cancelClose} onMouseLeave={hide}>{detail}</div>, document.body)}
  </>;
}
