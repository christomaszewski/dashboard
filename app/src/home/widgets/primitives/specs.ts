// Specs for the declarative primitives (gauge, sparkline, indicator, text). Pure — imported by
// home/widgets/specs.ts so the config schema registers them; components attach in
// widgets/builtins.tsx.
import { defineWidget, type BaseWidgetConfig } from "../../../widgets/registry";
import { optNum, optStr, optThresholds, reqNum, reqStr, type Obj, type Thresholds } from "../../../widgets/parse";
import { parseDefault, parseRule, type IndicatorOutcome, type IndicatorRule } from "./rules";

export interface GaugeWidgetConfig extends BaseWidgetConfig, Thresholds {
  type: "gauge";
  label: string;
  topic: string;
  field: string;
  min: number;
  max: number;
  unit?: string;
  precision?: number;
}

export interface SparklineWidgetConfig extends BaseWidgetConfig, Thresholds {
  type: "sparkline";
  label: string;
  topic: string;
  field: string;
  window_s?: number; // history kept (default 60)
  min?: number; // fixed y-range; autoscaled when absent
  max?: number;
  unit?: string;
  precision?: number;
}

export interface IndicatorWidgetConfig extends BaseWidgetConfig {
  type: "indicator";
  label: string;
  topic: string;
  field: string;
  rules: IndicatorRule[];
  default?: IndicatorOutcome;
}

export interface TextWidgetConfig extends BaseWidgetConfig {
  type: "text";
  text: string;
}

defineWidget<GaugeWidgetConfig>({
  type: "gauge",
  description: "arc gauge for a numeric field between min and max, threshold-colored",
  panelCapable: true,
  parse: (raw: Obj) => {
    const min = optNum(raw, "min") ?? 0;
    const max = reqNum(raw, "max");
    if (max <= min) throw new Error("'max' must be greater than 'min'");
    return {
      label: reqStr(raw, "label"),
      topic: reqStr(raw, "topic"),
      field: reqStr(raw, "field"),
      min,
      max,
      unit: optStr(raw, "unit"),
      precision: optNum(raw, "precision"),
      ...optThresholds(raw),
    };
  },
});

defineWidget<SparklineWidgetConfig>({
  type: "sparkline",
  description: "recent history of a numeric field as a mini line chart + current value",
  panelCapable: true,
  parse: (raw: Obj) => {
    const min = optNum(raw, "min");
    const max = optNum(raw, "max");
    if (min !== undefined && max !== undefined && max <= min) throw new Error("'max' must be greater than 'min'");
    const window_s = optNum(raw, "window_s");
    if (window_s !== undefined && window_s <= 0) throw new Error("'window_s' must be positive");
    return {
      label: reqStr(raw, "label"),
      topic: reqStr(raw, "topic"),
      field: reqStr(raw, "field"),
      window_s,
      min,
      max,
      unit: optStr(raw, "unit"),
      precision: optNum(raw, "precision"),
      ...optThresholds(raw),
    };
  },
});

defineWidget<IndicatorWidgetConfig>({
  type: "indicator",
  description: "value → colored state pill via declarative rules (equals/below/above/between/in/matches)",
  panelCapable: true,
  parse: (raw: Obj) => {
    const rawRules = raw["rules"];
    if (!Array.isArray(rawRules) || rawRules.length === 0) throw new Error("'rules' is required and must be a non-empty list");
    return {
      label: reqStr(raw, "label"),
      topic: reqStr(raw, "topic"),
      field: reqStr(raw, "field"),
      rules: rawRules.map((r, i) => parseRule(r, i)),
      default: parseDefault(raw["default"]),
    };
  },
});

defineWidget<TextWidgetConfig>({
  type: "text",
  description: "static operator notes (whitespace preserved)",
  panelCapable: true,
  label: (w) => w.label ?? "note",
  parse: (raw: Obj) => ({ label: optStr(raw, "label"), text: reqStr(raw, "text") }),
});
