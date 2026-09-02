// Attaches the React components to the built-in widget specs. Imported once by the app entry
// (main.tsx) BEFORE anything renders; the specs themselves live in home/widgets/specs.ts (and
// primitives/specs.ts) so the config schema stays React-free.
import "../home/widgets/specs";
import { attachWidgetComponent } from "./registry";
import { StatusWidget } from "../home/widgets/StatusWidget";
import { ServiceButtonWidget } from "../home/widgets/ServiceButtonWidget";
import { VideoWidget } from "../home/widgets/VideoWidget";
import { TopicValueWidget } from "../home/widgets/TopicValueWidget";
import { MapWidget } from "../home/widgets/MapWidget";
import { LifecycleWidget } from "../home/widgets/LifecycleWidget";
import { PanelWidget } from "../home/widgets/PanelWidget";
import { GaugeWidget } from "../home/widgets/primitives/GaugeWidget";
import { SparklineWidget } from "../home/widgets/primitives/SparklineWidget";
import { IndicatorWidget } from "../home/widgets/primitives/IndicatorWidget";
import { TextWidget } from "../home/widgets/primitives/TextWidget";

attachWidgetComponent("status", StatusWidget);
attachWidgetComponent("service_button", ServiceButtonWidget);
attachWidgetComponent("video", VideoWidget);
attachWidgetComponent("topic_value", TopicValueWidget);
attachWidgetComponent("map", MapWidget);
attachWidgetComponent("lifecycle", LifecycleWidget);
attachWidgetComponent("panel", PanelWidget);
attachWidgetComponent("gauge", GaugeWidget);
attachWidgetComponent("sparkline", SparklineWidget);
attachWidgetComponent("indicator", IndicatorWidget);
attachWidgetComponent("text", TextWidget);
