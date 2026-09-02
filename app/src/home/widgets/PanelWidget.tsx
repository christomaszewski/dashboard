import type { PanelItemWidgetConfig, PanelWidgetConfig } from "../../config/schema";
import { StatusWidget } from "./StatusWidget";
import { ServiceButtonWidget } from "./ServiceButtonWidget";
import { TopicValueWidget } from "./TopicValueWidget";
import { LifecycleWidget } from "./LifecycleWidget";
import { WidgetErrorBoundary } from "./WidgetErrorBoundary";

function PanelItem({ item }: { item: PanelItemWidgetConfig }) {
  switch (item.type) {
    case "status":
      return <StatusWidget widget={item} compact />;
    case "service_button":
      return <ServiceButtonWidget widget={item} compact />;
    case "topic_value":
      return <TopicValueWidget widget={item} compact />;
    case "lifecycle":
      return <LifecycleWidget widget={item} compact />;
  }
}

function itemLabel(item: PanelItemWidgetConfig): string | undefined {
  return item.type === "lifecycle" ? (item.label ?? item.service) : item.label;
}

/**
 * Grouped mini-widgets in one card: readout rows (topic dedup happens in the TopicStore — a
 * six-readout single-topic panel costs one zenoh sub), status pills, service buttons, lifecycle
 * controls. A bad or crashing item is one red row; its siblings render.
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
