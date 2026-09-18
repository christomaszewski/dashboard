import { describe, expect, it } from "vitest";
import { evaluateRules, parseDefault, parseRule, ruleMatches } from "./rules";

describe("ruleMatches", () => {
  it("equals / not_equals are strict, bigint compares as number", () => {
    expect(ruleMatches({ equals: true, level: "ok" }, true)).toBe(true);
    expect(ruleMatches({ equals: true, level: "ok" }, "true")).toBe(false);
    expect(ruleMatches({ equals: 3, level: "ok" }, 3n)).toBe(true);
    expect(ruleMatches({ not_equals: "AUTO", level: "warn" }, "MANUAL")).toBe(true);
    expect(ruleMatches({ not_equals: "AUTO", level: "warn" }, "AUTO")).toBe(false);
  });

  it("numeric conditions reject non-numbers", () => {
    expect(ruleMatches({ below: 20, level: "err" }, 19.9)).toBe(true);
    expect(ruleMatches({ below: 20, level: "err" }, 20)).toBe(false);
    expect(ruleMatches({ above: 80, level: "ok" }, "90")).toBe(false);
    expect(ruleMatches({ between: [20, 80], level: "warn" }, 20)).toBe(true);
    expect(ruleMatches({ between: [20, 80], level: "warn" }, 81)).toBe(false);
  });

  it("in / matches", () => {
    expect(ruleMatches({ in: ["GUIDED", "AUTO"], level: "ok" }, "AUTO")).toBe(true);
    expect(ruleMatches({ in: [1, 2], level: "ok" }, 2n)).toBe(true);
    expect(ruleMatches({ matches: "^RTK", level: "ok" }, "RTK_FIXED")).toBe(true);
    expect(ruleMatches({ matches: "^RTK", level: "ok" }, undefined)).toBe(false);
  });

  it("conditions AND together; a rule with none never matches", () => {
    expect(ruleMatches({ above: 0, below: 10, level: "ok" }, 5)).toBe(true);
    expect(ruleMatches({ above: 0, below: 10, level: "ok" }, 12)).toBe(false);
    expect(ruleMatches({ level: "ok" }, 5)).toBe(false);
  });
});

describe("evaluateRules", () => {
  const rules = [
    { below: 20, level: "err" as const, text: "LOW" },
    { below: 40, level: "warn" as const },
    { above: 39.9, level: "ok" as const, text: "OK" },
  ];

  it("first match wins, text passes through", () => {
    expect(evaluateRules(10, rules)).toEqual({ level: "err", text: "LOW" });
    expect(evaluateRules(30, rules)).toEqual({ level: "warn", text: undefined });
    expect(evaluateRules(90, rules)).toEqual({ level: "ok", text: "OK" });
  });

  it("falls back to the default, else idle", () => {
    expect(evaluateRules("n/a", rules, { level: "warn", text: "?" })).toEqual({ level: "warn", text: "?" });
    expect(evaluateRules(undefined, rules)).toEqual({ level: "idle" });
  });
});

describe("rule parsing", () => {
  it("validates level, condition presence, and shapes", () => {
    expect(parseRule({ equals: true, level: "ok", text: "ARMED" }, 0)).toEqual({ equals: true, level: "ok", text: "ARMED" });
    expect(() => parseRule({ equals: true }, 0)).toThrow(/'level' must be one of/);
    expect(() => parseRule({ level: "ok" }, 1)).toThrow(/needs a condition/);
    expect(() => parseRule({ between: [5, 1], level: "ok" }, 2)).toThrow(/'between' must be/);
    expect(() => parseRule({ matches: "(", level: "ok" }, 3)).toThrow(/not a valid regex/);
    expect(() => parseRule({ in: [], level: "ok" }, 4)).toThrow(/non-empty list/);
    expect(() => parseRule("nope", 5)).toThrow(/must be a mapping/);
  });

  it("parses the optional default", () => {
    expect(parseDefault(undefined)).toBeUndefined();
    expect(parseDefault({ level: "idle", text: "?" })).toEqual({ level: "idle", text: "?" });
    expect(() => parseDefault({ text: "x" })).toThrow(/'level' must be one of/);
  });
});
