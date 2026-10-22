// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RigAgent } from "../rig/types";
import { listContainers, readLogs, type DockerLogSnapshot } from "./client";
import { LogsTab } from "./LogsTab";

vi.mock("./client", async (original) => ({ ...await original<typeof import("./client")>(), listContainers: vi.fn(), readLogs: vi.fn() }));
vi.mock("../rig/RigContext", () => ({ useRigContext: () => ({ agents: world.agents }) }));
vi.mock("../transport/TransportContext", () => ({ useTransportContext: () => ({ transport: world.transport, status: world.status }) }));

const agent: RigAgent = { key: "fleet/1/rig", vehicleId: "1", alive: true,
  descriptor: { schema_version: 1, service: "rig-agent", vehicle_id: "1", vehicle: "Vehicle One", capabilities: { docker_logs: true, actuate: false } } };
const world = { agents: [agent], transport: {}, status: "connected" };
const first = { id: "a".repeat(64), name: "cam-1", image: "camera:local", state: "running", status: "Up", project: "cam", service: "camera" };
const second = { ...first, id: "b".repeat(64), name: "lidar-1", service: "lidar" };
const snapshot = (id = first.id, text = "2026-10-21T00:00:00Z hello"): DockerLogSnapshot => ({ container_id: id, tail: 200, text, truncated: false, at_unix_s: 1000 });
const flush = () => act(async () => {});
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const choose = (id = first.id) => fireEvent.change(screen.getByLabelText("Container / Compose service"), { target: { value: id } });

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  world.agents = [agent];
  world.status = "connected";
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  vi.mocked(listContainers).mockResolvedValue([first, second]);
  vi.mocked(readLogs).mockImplementation(async (_t, _a, id) => snapshot(id));
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("Logs tab", () => {
  it("loads only a chosen container, pauses, resumes and stops work on hidden tabs", async () => {
    const ui = render(<LogsTab active />);
    await flush();
    expect(readLogs).not.toHaveBeenCalled();
    choose();
    await flush();
    expect(readLogs).toHaveBeenLastCalledWith(world.transport, agent.key, first.id, 200);
    expect(screen.getByLabelText("Container log output").textContent).toContain("hello");
    await advance(2000);
    expect(readLogs).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    await advance(6000);
    expect(readLogs).toHaveBeenCalledTimes(2);
    expect(screen.getByText("Paused")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    await flush();
    expect(readLogs).toHaveBeenCalledTimes(3);
    ui.rerender(<LogsTab active={false} />);
    const inventoryCalls = vi.mocked(listContainers).mock.calls.length;
    await advance(30000);
    expect(readLogs).toHaveBeenCalledTimes(3);
    expect(listContainers).toHaveBeenCalledTimes(inventoryCalls);
    ui.rerender(<LogsTab active />);
    await flush();
    expect(readLogs).toHaveBeenCalledTimes(4);
    ui.unmount();
    await advance(10000);
    expect(readLogs).toHaveBeenCalledTimes(4);
  });

  it("discards late responses when switching containers and renders log content as text", async () => {
    let resolve!: (s: DockerLogSnapshot) => void;
    vi.mocked(readLogs).mockImplementationOnce(() => new Promise((r) => { resolve = r; }))
      .mockResolvedValueOnce(snapshot(second.id, "<img src=x onerror=alert(1)>"));
    render(<LogsTab active />);
    await flush();
    choose();
    await flush();
    await advance(6000);
    expect(readLogs).toHaveBeenCalledTimes(1); // no overlapping polls while waiting
    choose(second.id);
    await flush();
    await act(async () => resolve(snapshot(first.id, "wrong container")));
    const output = screen.getByLabelText("Container log output");
    expect(output.textContent).toBe("<img src=x onerror=alert(1)>");
    expect(output.querySelector("img")).toBeNull();
  });

  it("labels cached logs when disconnected, retries on reconnect, and stops in background browser tabs", async () => {
    const ui = render(<LogsTab active />);
    await flush(); choose(); await flush();
    world.status = "reconnecting";
    ui.rerender(<LogsTab active />);
    await advance(10000);
    expect(readLogs).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/Vehicle disconnected/)).toBeTruthy();
    expect(screen.getByLabelText("Container log output").textContent).toContain("hello");
    world.status = "connected";
    ui.rerender(<LogsTab active />);
    await flush();
    expect(readLogs).toHaveBeenCalledTimes(2);
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    fireEvent(document, new Event("visibilitychange"));
    await advance(10000);
    expect(readLogs).toHaveBeenCalledTimes(2);
  });

  it("shows failures with the previous snapshot, retries, and detects removed containers", async () => {
    render(<LogsTab active />);
    await flush(); choose(); await flush();
    vi.mocked(readLogs).mockRejectedValueOnce(new Error("logging driver does not support reading"));
    await advance(2000);
    expect(screen.getByRole("alert").textContent).toContain("logging driver");
    expect(screen.getByLabelText("Container log output").textContent).toContain("hello");
    await advance(2000);
    expect(screen.queryByRole("alert")).toBeNull();
    vi.mocked(listContainers).mockResolvedValue([second]);
    fireEvent.click(screen.getByRole("button", { name: "Refresh containers" }));
    await flush();
    const count = vi.mocked(readLogs).mock.calls.length;
    await advance(5000);
    expect(readLogs).toHaveBeenCalledTimes(count);
    expect(screen.getByText(/This container was removed/)).toBeTruthy();
  });

  it("requires a vehicle choice on a shared bus and clears the previous vehicle's selection", async () => {
    world.agents = [agent, { ...agent, key: "fleet/2/rig", vehicleId: "2" }];
    render(<LogsTab active />);
    await flush();
    expect(listContainers).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Vehicle"), { target: { value: agent.key } });
    await flush(); choose(); await flush();
    fireEvent.change(screen.getByLabelText("Vehicle"), { target: { value: "fleet/2/rig" } });
    await flush();
    expect(screen.queryByLabelText("Container log output")).toBeNull();
    expect(readLogs).toHaveBeenCalledTimes(1);
  });

  it("explains missing and old agents without querying unsupported endpoints", async () => {
    world.agents = [];
    const ui = render(<LogsTab active />);
    expect(screen.getByText(/No vehicle agent/)).toBeTruthy();
    world.agents = [{ ...agent, descriptor: { ...agent.descriptor, capabilities: {} } }];
    ui.rerender(<LogsTab active />);
    await flush();
    expect(screen.getByText(/does not support Docker logs/)).toBeTruthy();
    expect(listContainers).not.toHaveBeenCalled();
  });
});
