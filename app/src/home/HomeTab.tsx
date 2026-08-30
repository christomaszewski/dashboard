import { useConfig } from "../config/ConfigContext";
import type { ParsedWidget, WidgetConfig } from "../config/schema";
import type { TabId } from "../shell/useHashRoute";
import { DefaultHome } from "./DefaultHome";
import { StatusWidget } from "./widgets/StatusWidget";
import { ServiceButtonWidget } from "./widgets/ServiceButtonWidget";
import { VideoWidget } from "./widgets/VideoWidget";
import { TopicValueWidget } from "./widgets/TopicValueWidget";
import { WidgetErrorCard } from "./widgets/WidgetErrorCard";
import { WidgetErrorBoundary } from "./widgets/WidgetErrorBoundary";

function renderWidget(widget: WidgetConfig) {
  switch (widget.type) {
    case "status":
      return <StatusWidget widget={widget} />;
    case "service_button":
      return <ServiceButtonWidget widget={widget} />;
    case "video":
      return <VideoWidget widget={widget} />;
    case "topic_value":
      return <TopicValueWidget widget={widget} />;
  }
}

function spanClass(widget: WidgetConfig): string {
  const span = widget.span ?? (widget.type === "video" ? 2 : 1);
  return span === "full" ? " span-full" : span === 2 ? " span-2" : "";
}

function widgetLabel(w: WidgetConfig): string | undefined {
  return "label" in w ? w.label : w.stream;
}

/**
 * The config-driven Home. Containment doctrine: a bad widget renders an inline error card and a
 * crashing widget is caught by its boundary — the page never blanks. A structurally unusable home
 * block (or unparseable config) degrades to a banner + the built-in DefaultHome.
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
    <div className="home-grid">
      {home.widgets.map((pw: ParsedWidget, i) =>
        pw.ok ? (
          <div key={i} className={`home-cell${spanClass(pw.widget)}`}>
            <WidgetErrorBoundary label={widgetLabel(pw.widget)}>{renderWidget(pw.widget)}</WidgetErrorBoundary>
          </div>
        ) : (
          <div key={i} className="home-cell">
            <WidgetErrorCard message={pw.message} />
          </div>
        ),
      )}
    </div>
  );
}
