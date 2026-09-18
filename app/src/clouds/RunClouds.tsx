import { useEffect, useState } from "react";
import { fmtBytes } from "../rig/format";
import { fileUrl, listDir, type DirEntry } from "../rig/runsData";
import { supportedExtensions } from "./vendor/loaders";

const isCloud = (name: string) => supportedExtensions().includes(name.split(".").pop()?.toLowerCase() ?? "");

/**
 * The rig run registry's point clouds, browsed from the Clouds tab: every run under
 * /rig-data/runs/ (newest first — ids are UTC stamps), each a lazily listed tree of its
 * directories, where a file in a supported format opens in the viewer and the rest are counted so
 * the run's layout still reads. Same Caddy JSON listing the Rig tab's browser uses (runsData.ts):
 * one request per opened directory, nothing walked eagerly. `quiet` = render nothing when the
 * registry is not served or holds no runs (the idle overlay); otherwise say so (the panel).
 */
export function RunClouds({ onOpen, quiet = false }: { onOpen: (url: string, name: string) => void; quiet?: boolean }) {
  const [runs, setRuns] = useState<DirEntry[] | null | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    void listDir(["runs"]).then((e) => {
      if (!cancelled) setRuns(e);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (runs === undefined) return quiet ? null : <p className="dim clouds-runs-note">listing runs…</p>;
  if (runs === null)
    return quiet ? null : (
      <p className="dim clouds-runs-note">run registry not served — set rig_data_dir (or let rig's RIG_DATA_DIR through) so dash-up mounts it at /rig-data/</p>
    );
  const dirs = runs.filter((e) => e.isDir).sort((a, b) => b.name.localeCompare(a.name));
  if (dirs.length === 0) return quiet ? null : <p className="dim clouds-runs-note">no runs in the registry yet</p>;
  return (
    <div className="clouds-runs">
      {quiet && <p className="dim">Rig runs:</p>}
      <ul className="plain rig-tree">
        {dirs.map((r) => (
          <CloudDirNode key={r.name} segments={["runs", r.name]} name={r.name} onOpen={onOpen} />
        ))}
      </ul>
    </div>
  );
}

function CloudDirNode({ segments, name, onOpen }: { segments: string[]; name: string; onOpen: (url: string, name: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="rig-tree-dir">
      <button className="btn-link mono" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        {open ? "▾" : "▸"} {name}/
      </button>
      {open && <CloudDirTree segments={segments} onOpen={onOpen} />}
    </li>
  );
}

/** One directory: subdirectories (lazy), cloud files as open buttons, other files as a count. */
function CloudDirTree({ segments, onOpen }: { segments: string[]; onOpen: (url: string, name: string) => void }) {
  const [entries, setEntries] = useState<DirEntry[] | null | undefined>(undefined);
  const key = segments.join("/");
  useEffect(() => {
    let cancelled = false;
    void listDir(segments).then((e) => {
      if (!cancelled) setEntries(e);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  if (entries === undefined) return <p className="dim rig-tree-note">loading…</p>;
  if (entries === null) return <p className="dim rig-tree-note">not served</p>;
  const clouds = entries.filter((e) => !e.isDir && isCloud(e.name));
  const others = entries.filter((e) => !e.isDir && !isCloud(e.name)).length;
  const dirs = entries.filter((e) => e.isDir);
  if (entries.length === 0) return <p className="dim rig-tree-note">empty</p>;
  return (
    <ul className="plain rig-tree">
      {dirs.map((e) => (
        <CloudDirNode key={e.name} segments={[...segments, e.name]} name={e.name} onOpen={onOpen} />
      ))}
      {clouds.map((e) => (
        <li key={e.name} className="rig-tree-file clouds-runs-file">
          <button className="btn-link mono" onClick={() => onOpen(fileUrl([...segments, e.name]), e.name)} title={`open ${e.name} in the viewer`}>
            {e.name}
          </button>
          <span className="dim mono rig-file-size">{fmtBytes(e.size)}</span>
        </li>
      ))}
      {others > 0 && (
        <li className="dim rig-tree-note clouds-runs-other">
          {others} other file{others === 1 ? "" : "s"}
        </li>
      )}
    </ul>
  );
}
