import { RowActions, RowPill } from "./RowActions";
import type { RigStackRow } from "./types";
import { stackLevel } from "./types";

const TIER_LABEL: Record<string, string> = { infra: "infra", sensor: "sensors", autonomy: "autonomy" };
const TIER_ORDER = ["infra", "sensor", "autonomy"];

function healthChip(row: RigStackRow) {
  if (!row.enabled || row.state === "down" || row.health === "n/a" || row.health === "-") return null;
  const cls = row.health === "healthy" ? "chip ok" : row.health === "unhealthy" ? "chip err" : "chip warn";
  return <span className={cls}>{row.health}</span>;
}

/**
 * Every vehicle.yaml row, tier by tier in rig's order, with rig's compose roll-up, the launcher's
 * health, the one state pill that matters for the row (lifecycle > op_state > compose) and the
 * buttons that drive it. Nothing here re-interprets rig: state/health/op_state are verbatim.
 */
export function DeploymentTable({ rows, confirm = false, runLabel }: { rows: RigStackRow[]; confirm?: boolean; runLabel?: string | null }) {
  const tiers = [...TIER_ORDER, ...rows.map((r) => r.tier).filter((t) => !TIER_ORDER.includes(t))].filter((t, i, a) => a.indexOf(t) === i);
  return (
    <table className="data-table rig-table">
      <thead>
        <tr>
          <th>row</th>
          <th>service</th>
          <th>compose</th>
          <th>health</th>
          <th>state</th>
          <th>actions</th>
        </tr>
      </thead>
      {tiers.map((tier) => {
        const group = rows.filter((r) => r.tier === tier);
        if (group.length === 0) return null;
        return (
          <tbody key={tier}>
            <tr className="rig-tier-header">
              <td colSpan={6}>{TIER_LABEL[tier] ?? tier}</td>
            </tr>
            {group.map((row) => (
              <tr key={row.name} className={row.enabled ? undefined : "rig-row-disabled"} title={row.project}>
                <td className="mono">
                  {row.name}
                  {row.self && (
                    <span className="chip info rig-self" title="this row hosts the dashboard (and the rig agent)">
                      this dashboard
                    </span>
                  )}
                </td>
                <td className="dim">{row.service}</td>
                <td>
                  <span className={`pill ${stackLevel(row)}`} title="docker compose roll-up (rig status)">
                    {row.enabled ? row.state : "disabled"}
                  </span>
                  {row.enabled && (
                    <span className="dim mono rig-containers">
                      {" "}
                      {row.running}/{row.total}
                    </span>
                  )}
                </td>
                <td>{healthChip(row)}</td>
                <td>
                  <RowPill row={row} />
                </td>
                <td>
                  <RowActions row={row} confirm={confirm} runLabel={runLabel} />
                </td>
              </tr>
            ))}
          </tbody>
        );
      })}
    </table>
  );
}
