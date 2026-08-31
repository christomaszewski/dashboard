import type { TopicEntry } from "./graph";
import { useTopic } from "./useTopic";
import { MessageTree } from "./MessageTree";

/**
 * Live view of one ROS topic off the shared TopicStore: decoded latest sample at the store's flush
 * throttle, rate/size stats, transient-local seeding — all shared with any Home widgets watching
 * the same topic (inspecting a topic the Home page shows costs zero extra subscriptions).
 * Note: the Hz pill decays back to "no data"-style when publishing stops (the store recomputes the
 * rate every flush), where the old inspector froze at the last computed value.
 */
export function TopicInspector({ topic }: { topic: TopicEntry }) {
  const { snapshot } = useTopic(topic.name);
  const message = snapshot?.message;
  const hasData = message !== undefined || snapshot?.lastBytes !== undefined;

  return (
    <div className="inspector">
      <div className="inspector-header">
        <strong>{topic.name}</strong>
        <span className="dim">{topic.typeName}</span>
        <span className="dim" title={topic.typeHash}>
          {topic.typeHash.slice(0, 14)}…
        </span>
        <span className={`pill ${hasData ? "ok" : "idle"}`} style={{ marginLeft: "auto" }}>
          {snapshot?.hz !== undefined
            ? `${snapshot.hz.toFixed(1)} Hz`
            : hasData
              ? snapshot?.latched
                ? "latched"
                : "live"
              : "no data yet"}
          {snapshot?.lastBytes !== undefined ? ` · ${snapshot.lastBytes} B` : ""}
        </span>
      </div>
      {snapshot?.error && <div className="error-box">{snapshot.error}</div>}
      {snapshot?.warning && (
        <p className="dim" style={{ color: "var(--warn)", margin: ".5rem .9rem" }}>
          ⚠ {snapshot.warning}
        </p>
      )}
      {message && (
        <div className="inspector-body">
          <MessageTree message={message} />
        </div>
      )}
    </div>
  );
}
