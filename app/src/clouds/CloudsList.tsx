import { useEffect, useState } from "react";
import { supportedExtensions } from "./vendor/loaders";

interface CloudFile {
  name: string;
  sizeMb?: number;
}

/**
 * Lists the vehicle's /clouds/ directory when one is mounted (dash-up + `clouds_dir:` in the
 * instance YAML; Caddy's `file_server browse` answers JSON to an Accept: application/json GET).
 * Renders nothing when the listing is absent (dev servers, no mount) — drag & drop still works.
 */
export function CloudsList({ onOpen }: { onOpen: (url: string) => void }) {
  const [files, setFiles] = useState<CloudFile[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/clouds/", { headers: { Accept: "application/json" } });
        if (!res.ok || !(res.headers.get("content-type") ?? "").includes("json")) return;
        const listing: unknown = await res.json();
        if (cancelled || !Array.isArray(listing)) return;
        const exts = supportedExtensions();
        const found = listing
          .filter(
            (e): e is { name: string; size?: number; is_dir?: boolean } =>
              typeof e === "object" && e !== null && typeof (e as { name?: unknown }).name === "string",
          )
          .filter((e) => e.is_dir !== true && exts.some((x) => e.name.toLowerCase().endsWith(`.${x}`)))
          .map((e) => ({ name: e.name, sizeMb: typeof e.size === "number" ? e.size / 1e6 : undefined }));
        setFiles(found);
      } catch {
        // no /clouds/ here — hide the section
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!files || files.length === 0) return null;
  return (
    <div className="clouds-list">
      <p className="dim">On the vehicle:</p>
      <ul className="plain">
        {files.map((f) => (
          <li key={f.name}>
            <button className="btn" onClick={() => onOpen(`/clouds/${encodeURIComponent(f.name)}`)}>
              {f.name}
              {f.sizeMb !== undefined && <span className="meta"> {f.sizeMb.toFixed(1)} MB</span>}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
