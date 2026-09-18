import { describe, expect, it } from "vitest";
import { parseTemplate, renderTemplate } from "./template";

const fix = { latitude: 47.6062095, longitude: -122.3321, altitude: 56.04, status: { status: 0, service: 1 }, ok: true, id: "gps0", ranges: [1.5, 2.25] };

describe("parseTemplate", () => {
  it("splits literal text and {path} / {path:.Nf} placeholders, keeping their order", () => {
    const t = parseTemplate("lat {latitude:.6f}  lon {longitude:.6f}  alt {altitude:.1f} m ({status.status})");
    expect(t.paths).toEqual(["latitude", "longitude", "altitude", "status.status"]);
    expect(t.parts[0]).toEqual({ text: "lat " });
    expect(t.parts[1]).toEqual({ path: "latitude", precision: 6 });
    expect(t.parts.at(-1)).toEqual({ text: ")" });
  });

  it("'{{' and '}}' are literal braces; whitespace inside a placeholder is tolerated", () => {
    const t = parseTemplate("{{json}} {id} {{ {ok } }}");
    expect(t.parts).toEqual([{ text: "{json} " }, { path: "id", precision: undefined }, { text: " { " }, { path: "ok", precision: undefined }, { text: " }" }]);
  });

  it("rejects an unclosed brace, a stray brace, a bad path, a bad spec, and a template with no placeholder", () => {
    expect(() => parseTemplate("lat {latitude")).toThrow(/unclosed '\{' at 4/);
    expect(() => parseTemplate("lat } {latitude}")).toThrow(/stray '\}' at 4/);
    expect(() => parseTemplate("{lat-itude}")).toThrow(/not a field path/);
    expect(() => parseTemplate("{}")).toThrow(/not a field path/);
    expect(() => parseTemplate("{latitude:.6g}")).toThrow(/only format spec is '\.Nf'/);
    expect(() => parseTemplate("{latitude:6}")).toThrow(/only format spec is '\.Nf'/);
    expect(() => parseTemplate("just text")).toThrow(/no \{field\} placeholder/);
  });
});

describe("renderTemplate", () => {
  it("interpolates plucked values with per-placeholder precision; unformatted numbers keep 3 decimals max", () => {
    const t = parseTemplate("lat {latitude:.4f}, lon {longitude:.2f}, alt {altitude} m, r0 {ranges.0:.1f}");
    expect(renderTemplate(t, fix)).toEqual({ text: "lat 47.6062, lon -122.33, alt 56.04 m, r0 1.5", missing: [] });
    expect(renderTemplate(parseTemplate("{longitude}"), { longitude: 1.23456789 }).text).toBe("1.235");
  });

  it("renders booleans, strings, bigints and nested fields; a missing path renders '?' and is reported", () => {
    const t = parseTemplate("{id} ok={ok} svc={status.service} sats={status.satellites_used} big={big}");
    expect(renderTemplate(t, { ...fix, big: 12345678901234567890n })).toEqual({
      text: "gps0 ok=true svc=1 sats=? big=12345678901234567890",
      missing: ["status.satellites_used"],
    });
    expect(renderTemplate(t, undefined).missing).toEqual(["id", "ok", "status.service", "status.satellites_used", "big"]);
  });
});
