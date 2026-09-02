import type { CSSProperties } from "react";
import { useConfig } from "../config/ConfigContext";
import type { HomeLayout, ParsedWidget, WidgetConfig } from "../config/schema";
import { getWidget } from "../widgets/registry";
import type { TabId } from "../shell/useHashRoute";
import { DefaultHome } from "./DefaultHome";
import { WidgetErrorCard } from "./widgets/WidgetErrorCard";
import { WidgetErrorBoundary } from "./widgets/WidgetErrorBoundary";

/** Render through the registry — a spec without a component (or an unregistered type that somehow
 *  parsed) degrades to an inline error card like any other widget failure. */
function renderWidget(widget: WidgetConfig) {
  const def = getWidget(widget.type);
  if (!def?.component) {
    return <WidgetErrorCard title={widget.label ?? widget.type} message={`no renderer registered for widget type '${widget.type}'`} />;
  }
  const Component = def.component;
  return <Component widget={widget} />;
}

function spanClass(widget: WidgetConfig): string {
  if (widget.area) return ""; // the area defines the exact cells; span is ignored
  const span = widget.span ?? getWidget(widget.type)?.defaultSpan ?? 1;
  return span === "full" ? " span-full" : span === 2 ? " span-2" : "";
}

function widgetLabel(w: WidgetConfig): string | undefined {
  return getWidget(w.type)?.label?.(w) ?? w.label ?? w.type;
}

/**
 * Grid style for a configured layout. When areas are present, columns MUST be set too —
 * grid-template-areas alone leaves the tracks content-sized; minmax(0,1fr) stops a video's
 * min-content from blowing its track out. The schema guarantees `areas` rows are CSS-valid and
 * every widget `area` references a defined, unclaimed name (see parseAreas' doc comment).
 */
function gridStyle(layout: HomeLayout | undefined): CSSProperties | undefined {
  if (!layout) return undefined;
  const s: CSSProperties = {};
  if (layout.areas) {
    s.gridTemplateAreas = layout.areas.map((r) => `"${r}"`).join(" ");
    s.gridTemplateColumns = layout.columns ?? `repeat(${layout.columnCount}, minmax(0, 1fr))`;
  } else if (layout.columns) {
    s.gridTemplateColumns = layout.columns;
  }
  return s;
}

/**
 * The config-driven Home. Containment doctrine: a bad widget renders an inline error card, a
 * crashing widget is caught by its boundary, a bad layout degrades to auto-flow with one warning
 * banner — the page never blanks. A structurally unusable home block (or unparseable config)
 * degrades to a banner + the built-in DefaultHome.
 */
export function HomeTab({ navigate }: { navigate: (tab: TabId) => void }) {
  const config = useConfig();

  if (config.phase === "loading") return null;
  if (config.phase === "error") {
    return (
      <>
        <div className="error-box">{config.message}</div>
        <DefaultHome navigate={navigate} />
      </>
    );
  }
  const home = config.phase === "ready" ? config.config.home : undefined;
  if (!home) return <DefaultHome navigate={navigate} />;
  if (home.fatal !== undefined) {
    return (
      <>
        <div className="error-box">home config: {home.fatal}</div>
        <DefaultHome navigate={navigate} />
      </>
    );
  }
  if (home.widgets.length === 0) return <DefaultHome navigate={navigate} />;

  return (
    <>
      {home.layoutWarning && <div className="warn-box">home layout: {home.layoutWarning}</div>}
      <div className={`home-grid${home.layout?.areas ? " has-areas" : ""}`} style={gridStyle(home.layout)}>
        {home.widgets.map((pw: ParsedWidget, i) =>
          pw.ok ? (
            <div
              key={i}
              className={`home-cell${spanClass(pw.widget)}`}
              style={pw.widget.area ? { gridArea: pw.widget.area } : undefined}
            >
              {pw.warning && <span className="cell-warn">⚠ {pw.warning}</span>}
              <WidgetErrorBoundary label={widgetLabel(pw.widget)}>{renderWidget(pw.widget)}</WidgetErrorBoundary>
            </div>
          ) : (
            <div key={i} className="home-cell">
              <WidgetErrorCard message={pw.message} />
            </div>
          ),
        )}
      </div>
    </>
  );
}
