import { useEffect, useState } from "react";
import { fmtBytes } from "./format";
import { fileUrl, isSidecarName, listDir, loadSidecar, type DirEntry, type RecordingSidecar } from "./runsData";

/**
 * A lazily expanding view of one registry directory served by Caddy at /rig-data/. Files are
 * download links; a camera-service sidecar (`*.json` under recordings/) gets its session summary
 * inline. Nothing is walked eagerly — one listing per opened directory.
 */
export function DirTree({ segments, open = false }: { segments: string[]; open?: boolean }) {
  const [entries, setEntries] = useState<DirEntry[] | null | undefined>(undefined);
  const key = segments.join("/");
  useEffect(() => {
    let cancelled = false;
    setEntries(undefined);
    void listDir(segments).then((e) => {
      if (!cancelled) setEntries(e);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, open]);

  if (entries === undefined) return <p className="dim rig-tree-note">loading…</p>;
  if (entries === null) return <p className="dim rig-tree-note">not served (no /rig-data mount)</p>;
  if (entries.length === 0) return <p className="dim rig-tree-note">empty</p>;
  const inRecordings = segments.includes("recordings");
  return (
    <ul className="plain rig-tree">
      {entries.map((e) =>
        e.isDir ? (
          <DirNode key={e.name} segments={[...segments, e.name]} name={e.name} />
        ) : (
          <li key={e.name} className="rig-tree-file">
            <a className="mono" href={fileUrl([...segments, e.name])} download={e.name}>
              {e.name}
            </a>
            <span className="dim mono rig-file-size">{fmtBytes(e.size)}</span>
            {inRecordings && isSidecarName(e.name) && <SidecarChips segments={[...segments, e.name]} />}
          </li>
        ),
      )}
    </ul>
  );
}

function DirNode({ segments, name }: { segments: string[]; name: string }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="rig-tree-dir">
      <button className="btn-link mono" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        {open ? "▾" : "▸"} {name}/
      </button>
      {open && <DirTree segments={segments} open />}
    </li>
  );
}

function SidecarChips({ segments }: { segments: string[] }) {
  const [sc, setSc] = useState<RecordingSidecar | null | undefined>(undefined);
  const key = segments.join("/");
  useEffect(() => {
    let cancelled = false;
    void loadSidecar(segments).then((s) => {
      if (!cancelled) setSc(s);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  if (!sc) return null;
  const drops = sc.drops ? Object.entries(sc.drops).filter(([, v]) => v > 0) : [];
  return (
    <span className="rig-sidecar">
      {sc.frames !== undefined && <span className="chip">{sc.frames.toLocaleString()} frames</span>}
      {sc.segments !== undefined && <span className="chip">{sc.segments} segment{sc.segments === 1 ? "" : "s"}</span>}
      {sc.truncated && <span className="chip warn">TRUNCATED</span>}
      {sc.error && (
        <span className="chip warn" title={sc.error}>
          error
        </span>
      )}
      {drops.map(([k, v]) => (
        <span className="chip warn" key={k}>
          {k} {v}
        </span>
      ))}
    </span>
  );
}
