// The widget registry: the one door through which every Home-tab widget type enters — built-ins
// (home/widgets/specs.ts + widgets/builtins.tsx) and project extensions (src/extensions/) alike.
// A type is a SPEC (how to validate its YAML mapping, plus metadata the layout needs) and a
// COMPONENT (how to render it). They register separately so the spec side stays React-free:
// the config schema and its node-env tests import specs only; the app entry attaches components.
//
// Registration is last-wins by type, deliberately — an extension may override a built-in.
import type { ComponentType } from "react";
import type { Obj, WidgetSpan } from "./parse";

/** Every widget config carries these; the schema fills span/area from the mapping after parse. */
export interface BaseWidgetConfig {
  type: string;
  label?: string;
  span?: WidgetSpan;
  area?: string;
}

/** Components receive their parsed config; `compact` = rendered as a panel row (if panelCapable). */
export type WidgetComponent<C extends BaseWidgetConfig = BaseWidgetConfig> = ComponentType<{
  widget: C;
  compact?: boolean;
}>;

export interface WidgetSpec<C extends BaseWidgetConfig = BaseWidgetConfig> {
  type: string;
  /** Validate/normalize the raw YAML mapping (`type` already checked). Throw an Error with a
   *  human message to reject the widget — it becomes that widget's inline error card. */
  parse: (raw: Obj) => Omit<C, "type" | "span" | "area"> & Partial<Pick<C, "span" | "area">>;
  /** May appear inside a `panel`; the component must then honor `compact`. Default false. */
  panelCapable?: boolean;
  /** Grid cells when auto-flowing without an explicit `span`. Default 1. */
  defaultSpan?: WidgetSpan;
  /** Title for the error boundary / error rows. Default: `label` then `type`. */
  label?: (widget: C) => string | undefined;
  /** One line for docs/tooling. */
  description?: string;
}

export interface RegisteredWidget<C extends BaseWidgetConfig = BaseWidgetConfig> extends WidgetSpec<C> {
  component?: WidgetComponent<C>;
}

const registry = new Map<string, RegisteredWidget>();

/** Register (or replace) a widget type's spec. Keeps an already-attached component. */
export function defineWidget<C extends BaseWidgetConfig>(spec: WidgetSpec<C>): void {
  const existing = registry.get(spec.type);
  registry.set(spec.type, {
    ...(spec as unknown as WidgetSpec),
    component: existing?.component,
  });
}

/** Attach the renderer for an already-defined type. */
export function attachWidgetComponent<C extends BaseWidgetConfig>(type: string, component: WidgetComponent<C>): void {
  const entry = registry.get(type);
  if (!entry) throw new Error(`attachWidgetComponent: unknown widget type '${type}' — defineWidget it first`);
  entry.component = component as unknown as WidgetComponent;
}

/** Spec + component in one call — what an extension uses. */
export function registerWidget<C extends BaseWidgetConfig>(
  def: WidgetSpec<C> & { component: WidgetComponent<C> },
): void {
  defineWidget(def);
  attachWidgetComponent(def.type, def.component);
}

export function getWidget(type: string): RegisteredWidget | undefined {
  return registry.get(type);
}

/** Registered type names in registration order (built-ins first). */
export function widgetTypes(): string[] {
  return [...registry.keys()];
}

export function panelItemTypes(): string[] {
  return [...registry.values()].filter((w) => w.panelCapable).map((w) => w.type);
}
