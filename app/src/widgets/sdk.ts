// The widget SDK — everything an extension (src/extensions/) should import, in one place. Import
// from "../widgets/sdk" (or "../../widgets/sdk"), never from the internals directly: this is the
// surface that stays stable across dashboard versions.
//
// A widget is a SPEC (YAML validation + layout metadata) and a COMPONENT. Register both with
// `registerWidget(...)`. Components receive `{ widget, compact? }` and get their data through
// the hooks below — they never touch zenoh-ts, decoding, or WebRTC directly, and sharing (one
// subscription per topic, one WebRTC session per camera) comes for free.

// Registration + config plumbing
export { registerWidget, defineWidget, attachWidgetComponent, getWidget, widgetTypes } from "./registry";
export type { BaseWidgetConfig, WidgetSpec, WidgetComponent, RegisteredWidget } from "./registry";
export { isObj, optStr, optNum, optBool, optSpan, reqStr, reqNum, optThresholds } from "./parse";
export type { Obj, WidgetSpan, Thresholds } from "./parse";

// Live data — shared, refcounted, decoded once per topic app-wide
export { useTopic } from "../ros/useTopic";
export type { UseTopicResult } from "../ros/useTopic";
export type { TopicSnapshot } from "../ros/topicStore";
export { useRosGraphContext } from "../ros/RosGraphContext";
export type { RosGraph, TopicEntry, ServiceEntry, LivelinessEntity } from "../ros/graph";
export type { DecodedMessage } from "../schema/types";

// Camera streams — discovery + the pooled WebRTC session (one per camera however many tiles)
export { useStreamsContext } from "../streams/StreamsContext";
export { useStreamSession } from "../streams/pool/useStreamSession";
export type { SessionSnapshot } from "../streams/pool/sessionPool";
export type { DiscoveredStream, StreamDescriptor } from "../streams/types";
export { resolveStreamRef } from "../home/resolveStream";

// Service lifecycle control plane (camera-service recording standby/active)
export { useLifecycleContext } from "../lifecycle/LifecycleContext";
export { changeState, LifecycleError } from "../lifecycle/changeState";
export type { ChangeStateResult } from "../lifecycle/changeState";
export type { LifecycleService, LifecycleDescriptor } from "../lifecycle/types";

// ROS 2 service calls over zenoh (dynamic typing)
export { callService, ServiceCallError } from "../services/callService";
export type { ServiceCallResult, CallServiceOptions } from "../services/callService";

// Raw transport — for the rare widget that needs a keyexpr the hooks don't cover
export { useTransportContext } from "../transport/TransportContext";
export type { Transport, Sample, Subscription, GetReply } from "../transport/types";

// Value helpers
export { pluckField } from "../home/pluck";
export { formatValue, thresholdLevel, valueLevel } from "../home/value";
export type { ValueLevel } from "../home/value";
export { extractLatLon } from "../home/geo";
export { RateMonitor } from "../home/rate";
export { evaluateRules, parseRule, parseDefault } from "../home/widgets/primitives/rules";
export type { IndicatorRule, IndicatorOutcome } from "../home/widgets/primitives/rules";
export { SeriesBuffer, seriesPath } from "../home/widgets/primitives/series";
export type { SeriesPoint, SeriesPath } from "../home/widgets/primitives/series";
