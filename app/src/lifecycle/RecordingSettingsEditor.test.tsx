// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { LifecycleCard } from "./LifecycleCard";
import { TransportCtx } from "../transport/TransportContext";
import type { Transport, TransportGetOptions } from "../transport/types";
import { lifecycle } from "../test/harness";
import { parseLifecycleDescriptor, type LifecycleService, type RecordingSettings } from "./types";
import { configureRecording } from "./recordingSettings";
import { isSidecarName } from "../rig/runsData";

afterEach(cleanup);
const enc = (data: unknown) => new TextEncoder().encode(JSON.stringify(data));
const settings = (): RecordingSettings => ({
  generation: "boot-1", revision: 0, editable: true, source_mode_fixed: false,
  encoders: ["auto", "ffv1", "x264"],
  requested: { encoder: "ffv1", x264_crf: 23, x264_preset: "ultrafast", segment_seconds: 60,
    keyframe_interval_s: 0, bayer_tile: "off", bframes: 0, nvenc_preset: "", nvenc_maxperf: true, videoconvert_threads: 4 },
  resolved: { encoder: "ffv1", lossy: false, bayer_tile: "off" },
});
function service(): LifecycleService {
  const s = lifecycle("camera");
  s.descriptor.recording_settings = settings();
  return s;
}
function wrapper(s: LifecycleService, transport: Transport | null, status: "connected" | "reconnecting" = "connected") {
  return <TransportCtx.Provider value={{ transport, status, error: "", locator: "test" }}><LifecycleCard service={s} /></TransportCtx.Provider>;
}
const disabled = (label: string) => screen.getByLabelText(label, { exact: true }).matches(":disabled");

it("applies a patch through Zenoh before allowing activation with its acknowledged revision", async () => {
  const s = service();
  const get = vi.fn(async (key: string, opts?: TransportGetOptions) => {
    const body = JSON.parse(new TextDecoder().decode(opts?.payload));
    if (key.endsWith("/configure_recording")) {
      const next = { ...settings(), revision: 1, requested: { ...settings().requested, ...body.settings },
        resolved: { encoder: "x264", lossy: true, bayer_tile: "off" } };
      return [{ keyexpr: key, payload: enc({ ok: true, descriptor: { ...s.descriptor, recording_settings: next } }) }];
    }
    return [{ keyexpr: key, payload: enc({ ok: true, state: "active" }) }];
  });
  render(wrapper(s, { get } as unknown as Transport));
  fireEvent.change(screen.getByLabelText("Encoder"), { target: { value: "x264" } });
  fireEvent.change(screen.getByLabelText("Quality (CRF)"), { target: { value: "28" } });
  expect((screen.getByRole("button", { name: "activate" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Apply settings" }));
  await screen.findByText("Settings applied.");
  expect(get.mock.calls[0][0]).toBe(`${s.key}/configure_recording`);
  expect(JSON.parse(new TextDecoder().decode(get.mock.calls[0][1]?.payload))).toEqual({
    expected: { generation: "boot-1", revision: 0 }, settings: { encoder: "x264", x264_crf: 28 },
  });
  const activate = screen.getByRole("button", { name: "activate" }) as HTMLButtonElement;
  await waitFor(() => expect(activate.disabled).toBe(false));
  fireEvent.click(activate);
  await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
  expect(JSON.parse(new TextDecoder().decode(get.mock.calls[1][1]?.payload)).expected_recording_settings)
    .toEqual({ generation: "boot-1", revision: 1 });
});

it("locks settings while active or transitioning, but still allows stopping with unsaved edits", async () => {
  const s = service();
  const transport = { get: vi.fn(async () => []) } as unknown as Transport;
  const ui = render(wrapper(s, transport));
  fireEvent.change(screen.getByLabelText("Segment length (seconds)"), { target: { value: "10" } });
  for (const state of ["activating", "active", "deactivating"]) {
    ui.rerender(wrapper({ ...s, descriptor: { ...s.descriptor, state, transitions: state === "active" ? ["deactivate"] : [] } }, transport));
    expect(disabled("Encoder")).toBe(true);
    expect(disabled("Segment length (seconds)")).toBe(true);
    if (state === "active") expect((screen.getByRole("button", { name: "deactivate" }) as HTMLButtonElement).disabled).toBe(false);
  }
  ui.rerender(wrapper({ ...s, alive: false }, transport));
  expect(disabled("Encoder")).toBe(true);
  ui.rerender(wrapper(s, transport, "reconnecting"));
  expect(disabled("Encoder")).toBe(true);
});

it("keeps edits on a refusal and reloads after an external settings change", async () => {
  const s = service();
  const next = { ...s.descriptor, recording_settings: { ...settings(), revision: 1, requested: { ...settings().requested, segment_seconds: 15 } } };
  const get = vi.fn(async (key: string) => [{ keyexpr: key, payload: enc(key.endsWith("/configure_recording")
    ? { ok: false, error: "settings changed elsewhere", descriptor: next } : next) }]);
  render(wrapper(s, { get } as unknown as Transport));
  fireEvent.change(screen.getByLabelText("Segment length (seconds)"), { target: { value: "10" } });
  fireEvent.click(screen.getByRole("button", { name: "Apply settings" }));
  await screen.findByText("settings changed elsewhere");
  expect((screen.getByLabelText("Segment length (seconds)") as HTMLInputElement).value).toBe("10");
  expect(screen.getByRole("alert").textContent).toMatch(/changed elsewhere/);
  expect((screen.getByRole("button", { name: "Apply settings" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Reload settings" }));
  await screen.findByText("Settings reloaded; local edits discarded.");
  expect((screen.getByLabelText("Segment length (seconds)") as HTMLInputElement).value).toBe("15");
});

it("reports transport failures and rejects malformed optional settings safely", async () => {
  await expect(configureRecording({ get: async () => [] } as unknown as Transport, "key", { encoder: "x264" }, settings()))
    .rejects.toMatchObject({ kind: "no-reply" });
  await expect(configureRecording({ get: async () => [{ keyexpr: "key", payload: enc({ ok: true }) }] } as unknown as Transport,
    "key", { encoder: "x264" }, settings())).rejects.toMatchObject({ kind: "bad-reply" });
  const s = service();
  const parsed = parseLifecycleDescriptor(enc({ ...s.descriptor, recording_settings: { revision: "wrong" } }));
  expect(parsed?.state).toBe("inactive");
  expect(parsed?.recording_settings).toBeUndefined();
  render(wrapper(lifecycle("old-camera"), { get: async () => [] } as unknown as Transport));
  expect(screen.queryByRole("form", { name: "Recording settings" })).toBeNull();
  expect(isSidecarName("cam.recording-settings.json")).toBe(false);
  expect(isSidecarName("cam.json")).toBe(true);
});
