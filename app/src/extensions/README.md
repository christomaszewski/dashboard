# Writing a Home-tab widget

Projects add their own widgets here. A widget is one file that registers a **spec** (how to
validate its YAML mapping) and a **component** (how to render it), through the same registry the
built-ins use. Once registered, `type: <your_type>` works anywhere in the instance YAML — the grid
layout, `area:` placement, error containment, and (if you allow it) panel rows all come for free.

```
src/extensions/
  index.ts               ← import your widget modules here (that's the whole "install")
  example/CompassWidget.tsx
```

Rebuild the image (`rig build`) to ship it — extensions compile into the bundle, so they are
fully typed against the dashboard and cost nothing at runtime.

## The contract

```ts
import { registerWidget, reqStr, optNum, useTopic, pluckField, formatValue,
         type BaseWidgetConfig, type Obj } from "../widgets/sdk";

interface MyConfig extends BaseWidgetConfig { type: "my_widget"; label: string; topic: string; field: string }

function MyWidget({ widget, compact = false }: { widget: MyConfig; compact?: boolean }) {
  const { topic, snapshot } = useTopic(widget.topic);       // shared, decoded, refcounted
  const value = snapshot?.message !== undefined ? pluckField(snapshot.message, widget.field) : undefined;
  if (compact) return <div className="panel-row"><span className="row-label">{widget.label}</span>
                        <span className="row-value">{formatValue(value)}</span></div>;
  return <div className="widget-card"><span className="widget-label">{widget.label}</span>
           <span className="widget-value">{formatValue(value)}</span>
           <span className="dim mono widget-sub">{topic ? widget.topic : "waiting for topic…"}</span></div>;
}

registerWidget<MyConfig>({
  type: "my_widget",
  description: "one line for docs",
  panelCapable: true,        // may be a panel item → the component MUST honor `compact`
  defaultSpan: 1,            // grid cells when auto-flowing (video/map use 2)
  parse: (raw: Obj) => ({    // validate the YAML mapping; THROW a plain message to reject it
    label: reqStr(raw, "label"),
    topic: reqStr(raw, "topic"),
    field: reqStr(raw, "field"),
  }),
  component: MyWidget,
});
```

- `parse` gets the raw mapping with `type` already checked; it returns your fields (the schema
  fills `type`, `span`, `area` itself). Throwing `new Error("'topic' is required …")` turns that
  widget into an inline error card — the rest of the page still renders.
- The component must be a total function of its config + hooks: no throwing on missing data
  (render a waiting state), no global side effects. A runtime crash is caught by the error
  boundary and shown as a card/row, but don't rely on it.
- `compact` = you are a row inside a `panel`: render `.panel-row` with `.row-label` /
  `.row-value` / `.pill`, nothing tall.
- Use the dashboard's CSS classes and tokens (`.widget-card`, `.widget-label`, `.widget-value`,
  `.pill.ok|warn|err|idle`, `var(--accent)` …) so it looks native; add your own styles to
  `src/index.css` if you must.
- A type name that collides with a built-in **overrides** it (last registration wins) — useful,
  and easy to do by accident.

## What the SDK gives you (`src/widgets/sdk.ts`)

| Need | Use |
|---|---|
| A decoded ROS topic (one field or the whole message) | `useTopic(name)` → `{ topic, snapshot }`; `pluckField(snapshot.message, "a.b.0")`; `snapshot.hz`, `.error`, `.latched` |
| Only a rate, no decode | `useTopic(name, { decode: false })` |
| The ROS graph (nodes/topics/services) | `useRosGraphContext().graph` |
| A camera stream | `useStreamsContext().streams` + `resolveStreamRef`, then `useStreamSession(key)` → `{ snapshot, videoRef }` on a `<video>` |
| Recording standby/active | `useLifecycleContext()`, `changeState(transport, key, "activate")` |
| Call a ROS 2 service | `callService(transport, graph, "/svc", { … })` |
| Raw zenoh (rare) | `useTransportContext().transport.subscribe/get` |
| Formatting / thresholds | `formatValue`, `valueLevel`, `thresholdLevel`, `optThresholds` |
| Rules, series, rates, geo | `evaluateRules`, `SeriesBuffer` + `seriesPath`, `RateMonitor`, `extractLatLon` |

## Testing

Specs are pure: unit-test `parse` with vitest like `src/config/schema.test.ts` does (import your
module for its registration side effect, then `parseHome({ widgets: [{ type: "my_widget", … }] })`).
Rendering is verified in the browser with a dev config at `app/public/config/dashboard.yaml`.

## Before reaching for code

The declarative primitives cover a lot: `gauge`, `sparkline`, `indicator` (value → colored state
via `equals/below/above/between/in/matches` rules), `topic_value`, `status`, `text`, grouped in a
`panel`. See the commented `home:` block in `config/infra/dashboard.example.yaml`.
