import { useLifecycleContext } from "../lifecycle/LifecycleContext";
import type { LifecycleService } from "../lifecycle/types";
import { useLifecycleAction } from "../lifecycle/useLifecycleAction";
import { rowActions, rowPill, type RowAction } from "./actions";
import { useRigContext } from "./RigContext";
import type { RigStackRow } from "./types";
import { useRigSubmit } from "./useRigSubmit";

/** The lifecycle service driving a row, if its instance advertises one (same vehicle first). */
export function useRowLifecycle(row: RigStackRow): LifecycleService | undefined {
  const { find } = useLifecycleContext();
  const { agent } = useRigContext();
  return (agent ? find(`${agent.vehicleId}/${row.name}`) : undefined) ?? find(row.name);
}

/**
 * The buttons for one deployment row — lifecycle transitions when the instance advertises the
 * zenoh lifecycle, else rig's standby/activate, plus compose up/down (see actions.ts for the
 * rule). `runLabel` rides along as the lifecycle `run_id` so recordings carry the rig run label.
 */
export function RowActions({ row, confirm = false, runLabel }: { row: RigStackRow; confirm?: boolean; runLabel?: string | null }) {
  const { agent, runningJob } = useRigContext();
  const lifecycle = useRowLifecycle(row);
  const actions = rowActions(row, lifecycle, {
    actuate: agent?.descriptor.capabilities?.actuate !== false,
    busy: runningJob !== null,
    agentAlive: agent?.alive === true,
  });
  const lifecycleActions = actions.filter((a): a is RowAction & { kind: "lifecycle" } => a.kind === "lifecycle");
  const rigActions = actions.filter((a): a is RowAction & { kind: "rig" } => a.kind === "rig");
  if (actions.length === 0) return null;
  return (
    <span className="rig-actions">
      {lifecycle && lifecycleActions.length > 0 && (
        <LifecycleButtons service={lifecycle} transitions={lifecycleActions.map((a) => a.transition)} confirm={confirm} runId={runLabel ?? undefined} />
      )}
      {rigActions.length > 0 && <RigButtons actions={rigActions} confirm={confirm} />}
    </span>
  );
}

/** The row's one state pill (lifecycle > op_state > compose). */
export function RowPill({ row }: { row: RigStackRow }) {
  const lifecycle = useRowLifecycle(row);
  const pill = rowPill(row, lifecycle);
  return (
    <span className={`pill ${pill.level}`} title={pill.title}>
      {pill.text}
    </span>
  );
}

function LifecycleButtons({ service, transitions, confirm, runId }: { service: LifecycleService; transitions: string[]; confirm: boolean; runId?: string }) {
  const a = useLifecycleAction(service, { confirm, runId });
  return (
    <>
      {transitions.map((t) => (
        <button
          key={t}
          className={`btn${t === "activate" ? " primary" : ""}${a.confirming(t) ? " confirm" : ""}`}
          disabled={!a.canCall || a.busy || !service.alive}
          title={service.alive ? `${t} ${service.instance} (zenoh lifecycle)` : "lifecycle offline"}
          onClick={() => a.click(t)}
        >
          {a.label(t)}
        </button>
      ))}
      {a.feedback}
    </>
  );
}

function RigButtons({ actions, confirm }: { actions: (RowAction & { kind: "rig" })[]; confirm: boolean }) {
  const s = useRigSubmit({ confirm });
  return (
    <>
      {actions.map((a) => {
        const token = `${a.verb}:${a.name}`;
        return (
          <button
            key={token}
            className={`btn${a.primary ? " primary" : ""}${a.verb === "down" ? " danger" : ""}${s.confirming(token) ? " confirm" : ""}`}
            disabled={a.disabled !== undefined || s.busy}
            title={a.disabled ?? `rig ${a.verb} ${a.name} (as a job)`}
            onClick={() => s.click(token, { verb: a.verb, names: [a.name] })}
          >
            {s.label(token, a.verb)}
          </button>
        );
      })}
      {s.feedback}
    </>
  );
}
