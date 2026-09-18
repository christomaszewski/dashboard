import type { PanelItemWidgetConfig, PanelWidgetConfig } from "../../config/schema";
import { getWidget } from "../../widgets/registry";
import { WidgetErrorCard } from "./WidgetErrorCard";
import { WidgetErrorBoundary } from "./WidgetErrorBoundary";

function PanelItem({ item }: { item: PanelItemWidgetConfig }) {
  const def = getWidget(item.type);
  if (!def?.component) {
    return <WidgetErrorCard compact title={item.label ?? item.type} message={`no renderer registered for '${item.type}'`} />;
  }
  const Component = def.component;
  return <Component widget={item} compact />;
}

function itemLabel(item: PanelItemWidgetConfig): string | undefined {
  return getWidget(item.type)?.label?.(item) ?? item.label ?? item.type;
}

/**
 * Grouped mini-widgets in one card: readout rows (topic dedup happens in the TopicStore — a
 * six-readout single-topic panel costs one zenoh sub), and any panel-capable widget rendered
 * `compact`. A bad or crashing item is one red row; its siblings render.
 */
export function PanelWidget({ widget }: { widget: PanelWidgetConfig }) {
  return (
    <div className="widget-card widget-panel">
      {widget.title && <span className="widget-label">{widget.title}</span>}
      <div className="panel-rows">
        {widget.items.map((pi, j) =>
          pi.ok ? (
            <WidgetErrorBoundary key={j} compact label={itemLabel(pi.item)}>
              <PanelItem item={pi.item} />
            </WidgetErrorBoundary>
          ) : (
            <div key={j} className="panel-row is-err mono">
              {pi.message}
            </div>
          ),
        )}
      </div>
    </div>
  );
}
