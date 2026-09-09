// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BagRecordersWidgetConfig } from "../../config/schema";
import { EMPTY_GRAPH, type RosGraph, type ServiceEntry } from "../../ros/graph";
import { callService, ServiceCallError, type ServiceCallResult } from "../../services/callService";
import { renderWith } from "../../test/harness";
import { BagRecordersWidget, discoverRecorders } from "./BagRecordersWidget";

// The service call is the ONLY thing between the widget and the recorder: fake it by service name.
vi.mock("../../services/callService", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../services/callService")>()),
  callService: vi.fn(),
}));
const call = vi.mocked(callService);

afterEach(cleanup);
beforeEach(() => {
  call.mockReset(); // braces: a hook RETURNING the mock would register it as a cleanup (called bare)
});

const LOGGER = "/bag_logger/rosbag2_recorder";
const AUX = "/aux/rosbag2_recorder";
const PLAYER = "/rosbag2_player"; // where `ros2 bag play` (rig replay's ros2-bag-player row) sits
/** What rosbag2's player advertises: the recorder's pause/resume/is_paused/stop PLUS its own. */
const PLAYER_SERVICES = ["pause", "resume", "is_paused", "stop", "play", "play_next", "burst", "seek", "set_rate", "get_rate", "toggle_paused"];
const srv = (name: string, servers = 1): ServiceEntry =>
  ({ name, typeName: "rosbag2_interfaces/srv/X", servers: Array(servers).fill("n"), clients: [] }) as unknown as ServiceEntry;
/** Two recorders: the logger serving everything, aux only the pair + resume; plus lookalikes that
 *  are NOT recorders (a `/pause` without `/is_paused`, a recorder with no server left, and the bag
 *  PLAYER a `rig replay` brings up -- it serves the recorder's pair too). */
const graph = (): RosGraph => ({
  ...EMPTY_GRAPH,
  services: [
    ...["pause", "resume", "is_paused", "split_bagfile", "snapshot", "stop"].map((s) => srv(`${LOGGER}/${s}`)),
    ...["pause", "resume", "is_paused"].map((s) => srv(`${AUX}/${s}`)),
    ...PLAYER_SERVICES.map((s) => srv(`${PLAYER}/${s}`)),
    srv("/motor/pause"),
    srv("/gone/rosbag2_recorder/pause", 0),
    srv("/gone/rosbag2_recorder/is_paused", 0),
  ],
});
const widget = (over: Partial<BagRecordersWidgetConfig> = {}): BagRecordersWidgetConfig => ({
  type: "bag_recorders",
  actions: ["pause", "resume", "split"],
  poll_s: 3,
  ...over,
});
const result = (response: Record<string, unknown>): ServiceCallResult => ({ response, raw: new Uint8Array(), serverKeyexpr: "k", rttMs: 1 });
/** A recorder that answers is_paused from `paused` and every action with `reply`. */
const recorder = (paused: Record<string, boolean>, reply: Record<string, unknown> = {}) =>
  call.mockImplementation((_t, _g, name) => {
    const slash = name.lastIndexOf("/");
    const base = name.slice(0, slash);
    const leaf = name.slice(slash + 1);
    if (leaf === "is_paused") return Promise.resolve(result({ paused: paused[base] ?? false }));
    if (leaf === "pause") paused[base] = true;
    if (leaf === "resume") paused[base] = false;
    return Promise.resolve(result(reply));
  });
const row = (base: string) => document.querySelector(`[data-recorder="${base}"]`)!;
const buttons = (base: string) => [...row(base).querySelectorAll("button")].map((b) => b.textContent);
const transport = {} as NonNullable<Parameters<typeof renderWith>[1]>["transport"];

describe("discoverRecorders", () => {
  it("a recorder is a node base serving both …/pause and …/is_paused; sorted; optionally filtered", () => {
    const found = discoverRecorders(graph());
    expect(found.map((r) => r.base)).toEqual([AUX, LOGGER]);
    expect([...found[1].services].sort()).toEqual(["is_paused", "pause", "resume", "snapshot", "split_bagfile", "stop"]);
    expect(discoverRecorders(graph(), [LOGGER]).map((r) => r.base)).toEqual([LOGGER]);
    expect(discoverRecorders(graph(), ["/nope"])).toEqual([]);
  });

  it("a bag player is not a recorder, however completely it serves the recorder's pair", () => {
    // THE REGRESSION: under `rig replay` the ros2-bag-player serves /rosbag2_player/{pause,resume,
    // is_paused,stop} like a recorder does, and the widget listed it -- offering to pause the replay.
    // Its own services (play, seek, set_rate, ...) are what tell it apart; asking for it by name
    // must not resurrect it either.
    expect(discoverRecorders(graph()).map((r) => r.base)).not.toContain(PLAYER);
    expect(discoverRecorders(graph(), [PLAYER])).toEqual([]);
    const playerOnly: RosGraph = { ...EMPTY_GRAPH, services: PLAYER_SERVICES.map((s) => srv(`${PLAYER}/${s}`)) };
    expect(discoverRecorders(playerOnly)).toEqual([]);
    // one player-only service is enough -- a player with a trimmed service set is still a player
    const trimmed: RosGraph = { ...EMPTY_GRAPH, services: ["pause", "is_paused", "seek"].map((s) => srv(`${PLAYER}/${s}`)) };
    expect(discoverRecorders(trimmed)).toEqual([]);
  });
});

describe("BagRecordersWidget", () => {
  it("lists every recorder on the graph by namespace, polls is_paused for its state", async () => {
    recorder({ [AUX]: true });
    renderWith(<BagRecordersWidget widget={widget()} />, { graph: graph(), transport });
    expect(screen.getByText("2 on the graph")).toBeTruthy();
    expect(row(LOGGER).querySelector(".recorder-name")!.textContent).toBe("bag_logger");
    await waitFor(() => expect(row(LOGGER).querySelector(".pill")!.textContent).toBe("recording"));
    await waitFor(() => expect(row(AUX).querySelector(".pill")!.textContent).toBe("paused"));
    // the polls asked each recorder's own is_paused
    expect(call.mock.calls.map((c) => c[2]).sort()).toEqual([`${AUX}/is_paused`, `${LOGGER}/is_paused`]);
    // offered buttons follow the state (no "pause" while paused, no "resume" while recording) and
    // what the recorder serves (aux has no split_bagfile)
    expect(buttons(LOGGER)).toEqual(["pause", "split"]);
    expect(buttons(AUX)).toEqual(["resume"]);
  });

  it("pause / resume call the recorder's services with an empty (= now) request and flip the pill", async () => {
    recorder({});
    renderWith(<BagRecordersWidget widget={widget({ recorders: [LOGGER] })} />, { graph: graph(), transport });
    expect(screen.getByText("1 on the graph")).toBeTruthy();
    expect(document.querySelector(`[data-recorder="${AUX}"]`)).toBeNull();
    await waitFor(() => expect(buttons(LOGGER)).toEqual(["pause", "split"]));
    fireEvent.click(screen.getByRole("button", { name: /^pause/ }));
    await waitFor(() => expect(row(LOGGER).querySelector(".pill")!.textContent).toBe("paused"));
    expect(call).toHaveBeenCalledWith(transport, expect.anything(), `${LOGGER}/pause`, {}, expect.anything());
    expect(row(LOGGER).querySelector(".recorder-note")!.textContent).toBe("pause: ok");
    expect(buttons(LOGGER)).toEqual(["resume", "split"]);
    fireEvent.click(screen.getByRole("button", { name: /^resume/ }));
    await waitFor(() => expect(row(LOGGER).querySelector(".pill")!.textContent).toBe("recording"));
    expect(call).toHaveBeenCalledWith(transport, expect.anything(), `${LOGGER}/resume`, {}, expect.anything());
  });

  it("a non-zero return_code, a refused snapshot, and a failed call each show as an error note", async () => {
    recorder({}, { return_code: 2, error_string: "no bag open" });
    renderWith(<BagRecordersWidget widget={widget({ actions: ["split", "snapshot"] })} />, { graph: graph(), transport });
    await waitFor(() => expect(buttons(LOGGER)).toEqual(["split", "snapshot"]));
    fireEvent.click(row(LOGGER).querySelector("button")!);
    await waitFor(() => expect(row(LOGGER).querySelector(".recorder-note.is-err")!.textContent).toBe("split: no bag open"));
    expect(call).toHaveBeenCalledWith(transport, expect.anything(), `${LOGGER}/split_bagfile`, {}, expect.anything());

    recorder({}, { success: false });
    fireEvent.click(row(LOGGER).querySelectorAll("button")[1]);
    await waitFor(() => expect(row(LOGGER).querySelector(".recorder-note.is-err")!.textContent).toMatch(/^snapshot: refused/));

    call.mockRejectedValue(new ServiceCallError("timeout", `${LOGGER}/snapshot`, "no reply in 5000 ms"));
    fireEvent.click(row(LOGGER).querySelectorAll("button")[1]);
    await waitFor(() => expect(row(LOGGER).querySelector(".recorder-note.is-err")!.textContent).toBe("timeout: no reply in 5000 ms"));
  });

  it("confirm: the first click arms the button, the second fires; resume never asks", async () => {
    recorder({});
    renderWith(<BagRecordersWidget widget={widget({ confirm: true, recorders: [LOGGER] })} />, { graph: graph(), transport });
    await waitFor(() => expect(buttons(LOGGER)).toEqual(["pause", "split"]));
    const pause = screen.getByRole("button", { name: /^pause/ });
    fireEvent.click(pause);
    expect(pause.textContent).toBe("confirm?");
    expect(call.mock.calls.filter((c) => c[2] === `${LOGGER}/pause`)).toHaveLength(0);
    fireEvent.click(pause);
    await waitFor(() => expect(row(LOGGER).querySelector(".pill")!.textContent).toBe("paused"));
    fireEvent.click(screen.getByRole("button", { name: /^resume/ }));
    await waitFor(() => expect(row(LOGGER).querySelector(".pill")!.textContent).toBe("recording"));
  });

  it("without a transport nothing is polled and every button is disabled; without recorders it says so", () => {
    renderWith(<BagRecordersWidget widget={widget()} />, { graph: graph() });
    expect(call).not.toHaveBeenCalled();
    expect(row(LOGGER).querySelector(".pill")!.textContent).toBe("?");
    expect([...document.querySelectorAll("button")].every((b) => b.disabled)).toBe(true);
    cleanup();
    renderWith(<BagRecordersWidget widget={widget()} />, {});
    expect(screen.getByText(/no rosbag2 recorder on the graph/)).toBeTruthy();
    cleanup();
    // a replay session: the player is on the graph, no recorder -- the widget must say so, not list it
    const playerOnly: RosGraph = { ...EMPTY_GRAPH, services: PLAYER_SERVICES.map((s) => srv(`${PLAYER}/${s}`)) };
    renderWith(<BagRecordersWidget widget={widget()} />, { graph: playerOnly, transport });
    expect(screen.getByText("0 on the graph")).toBeTruthy();
    expect(document.querySelector(`[data-recorder="${PLAYER}"]`)).toBeNull();
    expect(call).not.toHaveBeenCalled();
    cleanup();
    renderWith(<BagRecordersWidget widget={widget({ recorders: ["/x/rosbag2_recorder"] })} />, { graph: graph() });
    expect(screen.getByText(/none of \/x\/rosbag2_recorder is on the graph/)).toBeTruthy();
  });
});
