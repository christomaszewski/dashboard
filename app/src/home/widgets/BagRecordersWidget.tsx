import { useEffect, useRef, useState } from "react";
import type { BagRecordersWidgetConfig } from "../../config/schema";
import type { BagRecorderAction } from "./specs";
import type { RosGraph } from "../../ros/graph";
import { useRosGraphContext } from "../../ros/RosGraphContext";
import { callService, ServiceCallError } from "../../services/callService";
import { useTransportContext } from "../../transport/TransportContext";

/** A rosbag2 recorder node found on the graph: its node base and the services it advertises. */
export interface Recorder {
  base: string; // /<ns>/rosbag2_recorder
  services: Set<string>; // the last segments it offers: pause, resume, is_paused, split_bagfile, snapshot
}

const RECORDER_SERVICES = ["pause", "resume", "is_paused", "split_bagfile", "snapshot", "stop"];
/** Services only rosbag2's PLAYER advertises (`ros2 bag play`; the ros2-bag-player row a `rig replay`
 *  brings up). The player ALSO serves pause / resume / is_paused / stop, so the recorder pair alone
 *  reads a player as a recorder -- and the widget would offer to pause the replay. A node serving
 *  any of these is a player, never a recorder. */
const PLAYER_ONLY_SERVICES = ["play", "play_next", "play_for", "burst", "seek", "set_rate", "get_rate", "toggle_paused"];
const ACTION_SERVICE: Record<BagRecorderAction, string> = {
  pause: "pause",
  resume: "resume",
  split: "split_bagfile",
  snapshot: "snapshot",
};

/** Recorders on the graph: a node base is a recorder when it serves BOTH `…/pause` and
 *  `…/is_paused` and NONE of the player-only services (rosbag2's player serves the same pair --
 *  it is the one lookalike). Namespaced per logger instance. */
export function discoverRecorders(graph: RosGraph, only?: string[]): Recorder[] {
  const bases = new Map<string, Set<string>>(); // every served leaf per base, player-only ones included
  for (const s of graph.services) {
    if (s.servers.length === 0) continue;
    const slash = s.name.lastIndexOf("/");
    if (slash <= 0) continue;
    const base = s.name.slice(0, slash);
    const leaf = s.name.slice(slash + 1);
    if (!RECORDER_SERVICES.includes(leaf) && !PLAYER_ONLY_SERVICES.includes(leaf)) continue;
    let set = bases.get(base);
    if (!set) bases.set(base, (set = new Set()));
    set.add(leaf);
  }
  const found = [...bases.entries()]
    .filter(([, set]) => set.has("pause") && set.has("is_paused") && !PLAYER_ONLY_SERVICES.some((p) => set.has(p)))
    .map(([base, set]) => ({ base, services: new Set([...set].filter((leaf) => RECORDER_SERVICES.includes(leaf))) }))
    .sort((a, b) => a.base.localeCompare(b.base));
  return only ? found.filter((r) => only.includes(r.base)) : found;
}

type RecState = "recording" | "paused" | "unknown";
type Phase = { kind: "idle" } | { kind: "confirm"; action: BagRecorderAction } | { kind: "calling" } | { kind: "ok" | "err"; text: string };
const FLASH_MS = 4000;

function explain(action: BagRecorderAction, response: Record<string, unknown>): string | null {
  // Pause and Snapshot/IsPaused reply simply; Resume and SplitBagfile carry a return_code + error_string.
  const code = response["return_code"];
  if (typeof code === "number" && code !== 0) return `${action}: ${String(response["error_string"] || `return code ${code}`)}`;
  if (action === "snapshot" && response["success"] === false) return "snapshot: refused (is the recorder in snapshot mode?)";
  return null;
}

function RecorderRow({ rec, widget }: { rec: Recorder; widget: BagRecordersWidgetConfig }) {
  const { transport, status } = useTransportContext();
  const online = !!transport && status === "connected";
  const { graph } = useRosGraphContext();
  const [state, setState] = useState<RecState>("unknown");
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const flashTimer = useRef<number | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (flashTimer.current !== null) clearTimeout(flashTimer.current);
    };
  }, []);

  // Poll is_paused: the recorder publishes no state, so the state is asked for, every poll_s.
  useEffect(() => {
    if (!transport) return;
    let stop = false;
    const tick = async () => {
      try {
        const r = await callService(transport, graph, `${rec.base}/is_paused`, {}, { timeoutMs: 2000 });
        if (!stop && alive.current) setState(r.response["paused"] === true ? "paused" : "recording");
      } catch {
        if (!stop && alive.current) setState("unknown");
      }
    };
    void tick();
    const id = window.setInterval(() => void tick(), Math.max(500, widget.poll_s * 1000));
    return () => {
      stop = true;
      clearInterval(id);
    };
  }, [transport, graph, rec.base, widget.poll_s]);

  const flash = (next: Phase) => {
    setPhase(next);
    if (flashTimer.current !== null) clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => alive.current && setPhase({ kind: "idle" }), FLASH_MS);
  };
  const fire = async (action: BagRecorderAction) => {
    if (!transport) return;
    setPhase({ kind: "calling" });
    try {
      // omitted request fields zero-fill: Resume/SplitBagfile with a zero time = now
      const r = await callService(transport, graph, `${rec.base}/${ACTION_SERVICE[action]}`, {}, { timeoutMs: 5000 });
      const problem = explain(action, r.response as Record<string, unknown>);
      if (problem) flash({ kind: "err", text: problem });
      else {
        if (action === "pause") setState("paused");
        if (action === "resume") setState("recording");
        flash({ kind: "ok", text: `${action}: ok` });
      }
    } catch (e) {
      flash({ kind: "err", text: e instanceof ServiceCallError ? `${e.kind}: ${e.message}` : String(e) });
    }
  };
  const click = (action: BagRecorderAction) => {
    if (phase.kind === "calling") return;
    if (widget.confirm && action !== "resume" && !(phase.kind === "confirm" && phase.action === action)) {
      setPhase({ kind: "confirm", action });
      return;
    }
    void fire(action);
  };

  const offered = widget.actions.filter((a) => rec.services.has(ACTION_SERVICE[a]));
  const visible = offered.filter((a) => (a === "pause" ? state !== "paused" : a === "resume" ? state !== "recording" : true));
  const name = rec.base.replace(/\/rosbag2_recorder$/, "").replace(/^\//, "") || rec.base;
  const pill = state === "recording" ? "ok" : state === "paused" ? "warn" : "idle";
  const dis = !online || phase.kind === "calling";
  return (
    <div className="recorder-row" data-recorder={rec.base}>
      <span className="recorder-name mono" title={rec.base}>
        {name}
      </span>
      <span className={`pill ${pill}`}>{state === "unknown" ? "?" : state}</span>
      <span className="recorder-actions">
        {visible.map((a) => (
          <button
            key={a}
            className={`btn small${phase.kind === "confirm" && phase.action === a ? " confirm" : ""}`}
            disabled={dis}
            title={`${a} ${name}`}
            onClick={() => click(a)}
          >
            {phase.kind === "confirm" && phase.action === a ? "confirm?" : a}
          </button>
        ))}
      </span>
      {(phase.kind === "ok" || phase.kind === "err") && (
        <span className={`recorder-note dim mono${phase.kind === "err" ? " is-err" : ""}`}>{phase.text}</span>
      )}
    </div>
  );
}

/**
 * Every rosbag2 recorder on the graph, with its WRITING controlled from here: pause / resume (and
 * split / snapshot when offered) through the recorder's own services, state polled from
 * `is_paused`. Not session control — a bag session belongs to a rig run, and starting or ending
 * one stays rig's call from the vehicle; this widget only decides whether the open session is
 * being written to.
 */
export function BagRecordersWidget({ widget }: { widget: BagRecordersWidgetConfig }) {
  const { graph } = useRosGraphContext();
  const recorders = discoverRecorders(graph, widget.recorders);
  return (
    <div className="widget-card bag-recorders">
      <span className="widget-label">
        {widget.label ?? "Bag recorders"}
        <span className="dim mono lifecycle-vehicle">{recorders.length} on the graph</span>
      </span>
      {recorders.length === 0 ? (
        <p className="empty">
          {widget.recorders
            ? `none of ${widget.recorders.join(", ")} is on the graph`
            : "no rosbag2 recorder on the graph (a node serving …/pause and …/is_paused; a bag player is not one)"}
        </p>
      ) : (
        recorders.map((r) => <RecorderRow key={r.base} rec={r} widget={widget} />)
      )}
    </div>
  );
}
