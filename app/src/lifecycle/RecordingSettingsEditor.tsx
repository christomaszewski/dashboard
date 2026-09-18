import { useEffect, useState, type FormEvent } from "react";
import { useTransportContext } from "../transport/TransportContext";
import { configureRecording } from "./recordingSettings";
import { parseLifecycleDescriptor, type RecordingSettings, type RecordingSettingsValues } from "./types";

const ENCODERS: Record<string, string> = {
  auto: "Automatic (lossless / source copy)", x264: "H.264 (lossy, lower CPU)",
  ffv1: "FFV1 (lossless)", "hw-hevc-lossless": "Hardware HEVC (lossless)",
  "x265-lossless": "Software HEVC (lossless)", "stream-copy": "Copy source bitstream",
};
const PRESETS = ["ultrafast", "superfast", "veryfast", "faster", "fast", "medium", "slow", "slower", "veryslow", "placebo"];

export function RecordingSettingsEditor({ settings, serviceKey, disabled, onBlocking, onApplied }: {
  settings: RecordingSettings; serviceKey: string; disabled: boolean;
  onBlocking: (blocked: boolean) => void; onApplied: (settings: RecordingSettings) => void;
}) {
  const { transport } = useTransportContext();
  const [draft, setDraft] = useState<{ base: RecordingSettings; changes: Partial<RecordingSettingsValues> } | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);
  const stale = !!draft && (draft.base.generation !== settings.generation || draft.base.revision !== settings.revision);
  const locked = disabled || !settings.editable;
  const values = draft ? { ...draft.base.requested, ...draft.changes } : settings.requested;
  useEffect(() => { onBlocking(!!draft || saving); }, [draft, saving, onBlocking]);
  useEffect(() => () => onBlocking(false), [onBlocking]);

  function edit<K extends keyof RecordingSettingsValues>(key: K, value: RecordingSettingsValues[K]) {
    if (locked || saving) return;
    setDraft(current => ({ base: current?.base ?? settings, changes: { ...current?.changes, [key]: value } }));
    setMessage("");
  }
  async function apply(event: FormEvent) {
    event.preventDefault();
    if (!transport || locked || saving || !draft || stale) return;
    setSaving(true);
    setMessage("");
    try {
      const result = await configureRecording(transport, serviceKey, draft.changes, draft.base);
      const next = result.descriptor?.recording_settings;
      if (next) onApplied(next);
      if (!result.ok) throw new Error(result.error || "Recording settings were refused.");
      setDraft(null);
      setFailed(false);
      setMessage("Settings applied.");
    } catch (error) {
      setFailed(true);
      setMessage(error instanceof Error ? error.message : String(error));
    } finally { setSaving(false); }
  }
  async function reload() {
    if (!transport || saving) return;
    setSaving(true);
    try {
      const replies = await transport.get(serviceKey, { timeoutMs: 10_000 });
      const next = replies[0] && parseLifecycleDescriptor(replies[0].payload)?.recording_settings;
      if (!next) throw new Error("Could not reload settings; edits have been kept.");
      onApplied(next);
      setDraft(null);
      setMessage("Settings reloaded; local edits discarded.");
      setFailed(false);
    } catch (error) {
      setFailed(true);
      setMessage(error instanceof Error ? error.message : String(error));
    } finally { setSaving(false); }
  }
  const number = (key: "x264_crf" | "segment_seconds" | "keyframe_interval_s" | "bframes" | "videoconvert_threads",
    label: string, min: number, max: number, step = 1) => (
      <label>{label}<input type="number" min={min} max={max} step={step} required
        value={Number.isFinite(values[key]) ? values[key] : ""} onChange={e => edit(key, e.target.valueAsNumber)} /></label>
    );
  return (
    <form className="recording-settings" onSubmit={event => void apply(event)} aria-label="Recording settings">
      <div className="recording-settings-heading"><strong>Recording settings</strong>
        <span className={`chip ${locked ? "warn" : "info"}`}>{locked ? "locked" : draft ? "unsaved" : "ready"}</span>
      </div>
      <fieldset disabled={locked || saving}>
        <label>Encoder<select value={values.encoder} onChange={e => edit("encoder", e.target.value)}>
          {settings.encoders.map(encoder => <option key={encoder} value={encoder}>{ENCODERS[encoder] ?? encoder}</option>)}
        </select></label>
        {values.encoder === "x264" && <>
          {number("x264_crf", "Quality (CRF)", 1, 50)}
          <p className="dim">Lower CRF keeps more detail; higher CRF makes smaller files. Default: 23. Color is recorded at 4:2:0.</p>
          <label>Encoding speed<select value={values.x264_preset} onChange={e => edit("x264_preset", e.target.value)}>
            {PRESETS.map(preset => <option key={preset}>{preset}</option>)}
          </select></label>
          <p className="dim">Ultrafast uses the least CPU; slower presets favor smaller files.</p>
        </>}
        {number("segment_seconds", "Segment length (seconds)", 1, 86400)}
        <details><summary>Advanced settings</summary><div className="recording-settings-advanced">
          {number("keyframe_interval_s", "Keyframe interval (seconds, 0 = default)", 0, 3600, .1)}
          {number("videoconvert_threads", "Conversion threads (0 = automatic)", 0, 64)}
          <label>Bayer tiling<select value={String(values.bayer_tile)} onChange={e => edit("bayer_tile", e.target.value)}>
            {["off", "plain", "green_diff", "rct"].map(mode => <option key={mode}>{mode}</option>)}
          </select></label>
          {number("bframes", "B-frames", 0, 16)}
          <label>Hardware HEVC preset<select value={values.nvenc_preset} onChange={e => edit("nvenc_preset", e.target.value)}>
            <option value="">Encoder default</option>
            {["disable", "ultrafast", "fast", "medium", "slow"].map(preset => <option key={preset}>{preset}</option>)}
          </select></label>
          <label className="recording-settings-check"><input type="checkbox" checked={values.nvenc_maxperf}
            onChange={e => edit("nvenc_maxperf", e.target.checked)} />Hardware maximum performance</label>
          <p className="dim">Controls apply to compatible encoders. FFV1 ignores GOP and B-frame settings; H.264 disables B-frames and Bayer tiling. Source copy uses the camera’s keyframes.</p>
        </div></details>
      </fieldset>
      <p className="dim">{draft ? "Currently applied" : "Selected on this machine"}: <strong>{settings.resolved.encoder}</strong>
        {settings.resolved.lossy === true ? " · lossy" : settings.resolved.lossy === false ? " · lossless encode" : " · source bitstream"}
        {settings.resolved.bayer_tile !== "off" ? ` · Bayer ${settings.resolved.bayer_tile}` : ""}</p>
      {settings.requested.encoder !== "auto" && settings.requested.encoder !== settings.resolved.encoder &&
        <p role="status">Requested {settings.requested.encoder}; this source or machine requires the {settings.resolved.encoder} fallback.</p>}
      {settings.source_mode_fixed && <p className="dim">Switching between source copy and re-encoding requires a service restart.</p>}
      {locked && <p className="dim">Settings are read-only while recording, transitioning, or offline.</p>}
      {draft && !stale && <p className="dim">Apply or reload settings before starting a recording.</p>}
      {stale && <p role="alert">Settings changed elsewhere. Reload and review before recording.</p>}
      {(draft || failed) && <div className="lifecycle-actions">
        <button type="submit" className="btn" disabled={locked || saving || !draft || stale}>{saving ? "saving…" : "Apply settings"}</button>
        <button type="button" className="btn" disabled={disabled || saving} onClick={() => void reload()}>Reload settings</button>
      </div>}
      {message && <p role="status" className={failed ? "is-err" : "dim"}>{message}</p>}
    </form>
  );
}
