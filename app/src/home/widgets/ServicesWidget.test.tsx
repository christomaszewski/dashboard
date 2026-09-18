// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MessageDefinition } from "@foxglove/message-definition";
import type { ServicesWidgetConfig } from "../../config/schema";
import { EMPTY_GRAPH, type RosGraph, type ServiceEntry } from "../../ros/graph";
import { callService, describeService, ServiceCallError, type ServiceCallResult, type ServiceShape } from "../../services/callService";
import { renderWith } from "../../test/harness";
import { responseLines, ServicesWidget } from "./ServicesWidget";

vi.mock("../../services/callService", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../services/callService")>()),
  callService: vi.fn(),
  describeService: vi.fn(),
}));
const call = vi.mocked(callService);
const describe_ = vi.mocked(describeService);

afterEach(cleanup);
beforeEach(() => {
  call.mockReset();
  describe_.mockReset();
});

const SET_BOOL_REQ: MessageDefinition = { name: "std_srvs/srv/SetBool_Request", definitions: [{ type: "bool", name: "data" }] };
const TIME: MessageDefinition = { name: "builtin_interfaces/msg/Time", definitions: [{ type: "int32", name: "sec" }, { type: "uint32", name: "nanosec" }] };
const RESUME_REQ: MessageDefinition = {
  name: "rosbag2_interfaces/srv/Resume_Request",
  definitions: [
    { type: "builtin_interfaces/msg/Time", name: "resume_time", isComplex: true },
    { type: "int32", name: "resume_mode" },
    { type: "string", name: "tracking_topic_name" },
  ],
};
const EMPTY_REQ: MessageDefinition = { name: "std_srvs/srv/Trigger_Request", definitions: [] };
const SHAPES: Record<string, ServiceShape> = {
  "/recorder/start": { typeName: "std_srvs/srv/SetBool", typeHash: "h1", requestDefs: [SET_BOOL_REQ] },
  "/bag/resume": { typeName: "rosbag2_interfaces/srv/Resume", typeHash: "h2", requestDefs: [RESUME_REQ, TIME] },
  "/bag/pause": { typeName: "std_srvs/srv/Trigger", typeHash: "h3", requestDefs: [EMPTY_REQ] },
};
const srv = (name: string, typeName: string, servers = 1): ServiceEntry =>
  ({ name, typeName, servers: Array(servers).fill({ topic: { typeHash: "h" } }), clients: [] }) as unknown as ServiceEntry;
const graph = (): RosGraph => ({
  ...EMPTY_GRAPH,
  services: [
    srv("/recorder/start", "std_srvs/srv/SetBool"),
    srv("/bag/resume", "rosbag2_interfaces/srv/Resume"),
    srv("/bag/pause", "std_srvs/srv/Trigger"),
    srv("/gnss/reset", "std_srvs/srv/Trigger", 0),
  ],
});
const result = (response: Record<string, unknown>): ServiceCallResult => ({ response, raw: new Uint8Array(), serverKeyexpr: "k", rttMs: 12.4 });
const transport = {} as NonNullable<Parameters<typeof renderWith>[1]>["transport"];
const widget = (over: Partial<ServicesWidgetConfig> = {}): ServicesWidgetConfig => ({
  type: "services",
  services: [{ service: "/recorder/start", label: "Start", request: { data: true } }, { service: "/gnss/reset" }],
  ...over,
});
const row = (service: string) => document.querySelector(`[data-service="${service}"]`)!;
const callButton = (service: string) => row(service).querySelector<HTMLButtonElement>(".service-head button")!;
const response = (service: string) => row(service).querySelector(".service-response")?.textContent ?? null;
const shapesByName = () => describe_.mockImplementation((_t, _g, name) => (SHAPES[name] ? Promise.resolve(SHAPES[name]) : Promise.reject(new ServiceCallError("no-server", name, "no server"))));

describe("responseLines", () => {
  it("one key: value line per field; nested as JSON; bigints as digits; empty noted", () => {
    expect(responseLines({ success: true, message: "started", stamp: { sec: 1n }, ids: [1, 2] })).toEqual(["success: true", "message: started", "stamp: {\"sec\":\"1\"}", "ids: [1,2]"]);
    expect(responseLines({})).toEqual(["(empty response)"]);
    expect(responseLines({ structure_needs_at_least_one_member: 0 })).toEqual(["(empty response)"]);
  });
});

describe("ServicesWidget", () => {
  it("one row per service: server status, the type, a form from the live request type pre-filled from `request:`; no server = no form, button disabled", async () => {
    shapesByName();
    renderWith(<ServicesWidget widget={widget({ label: "Ops" })} />, { graph: graph(), transport });
    expect(screen.getByText("Ops")).toBeTruthy();
    expect(row("/recorder/start").querySelector(".pill")!.textContent).toBe("ready");
    expect(row("/gnss/reset").querySelector(".pill")!.textContent).toBe("no server");
    expect(callButton("/gnss/reset").disabled).toBe(true);
    await waitFor(() => expect(row("/recorder/start").querySelector(".widget-sub")!.textContent).toBe("std_srvs/srv/SetBool"));
    const data = row("/recorder/start").querySelector<HTMLInputElement>('input[aria-label="data"]')!;
    expect(data.type).toBe("checkbox");
    expect(data.checked).toBe(true); // request: { data: true }
    expect(row("/gnss/reset").querySelector(".service-fields")).toBeNull();
    expect(describe_.mock.calls.map((c) => c[2])).toEqual(["/recorder/start"]); // not asked for the server-less one
    expect(callButton("/recorder/start").disabled).toBe(false);
  });

  it("call sends the form's values and keeps the response on the row; editing a field changes the next request", async () => {
    shapesByName();
    call.mockResolvedValue(result({ success: true, message: "started" }));
    renderWith(<ServicesWidget widget={widget()} />, { graph: graph(), transport });
    await waitFor(() => expect(row("/recorder/start").querySelector('input[aria-label="data"]')).not.toBeNull());
    fireEvent.click(callButton("/recorder/start"));
    await waitFor(() => expect(response("/recorder/start")).toMatch(/success: true\nmessage: started/));
    expect(response("/recorder/start")).toMatch(/reply · 12 ms/);
    expect(call).toHaveBeenCalledWith(transport, expect.anything(), "/recorder/start", { data: true }, expect.anything());
    fireEvent.click(row("/recorder/start").querySelector('input[aria-label="data"]')!); // uncheck
    fireEvent.click(callButton("/recorder/start"));
    await waitFor(() => expect(call).toHaveBeenCalledTimes(2));
    expect(call.mock.calls[1][3]).toEqual({ data: false });
  });

  it("nested and typed fields: JSON for a Time, an integer, a string; a value the type cannot take is refused before calling; reset restores defaults", async () => {
    shapesByName();
    call.mockResolvedValue(result({ return_code: 0, error_string: "" }));
    renderWith(<ServicesWidget widget={widget({ services: [{ service: "/bag/resume", request: { resume_mode: 2 } }, "/bag/pause" as unknown as { service: string }] })} />, {
      graph: graph(),
      transport,
    });
    await waitFor(() => expect(row("/bag/resume").querySelector('input[aria-label="resume_time"]')).not.toBeNull());
    const time = row("/bag/resume").querySelector<HTMLInputElement>('input[aria-label="resume_time"]')!;
    const mode = row("/bag/resume").querySelector<HTMLInputElement>('input[aria-label="resume_mode"]')!;
    const topic = row("/bag/resume").querySelector<HTMLInputElement>('input[aria-label="tracking_topic_name"]')!;
    expect([time.value, mode.value, topic.value]).toEqual(['{"sec":0,"nanosec":0}', "2", ""]);
    fireEvent.change(mode, { target: { value: "one" } });
    fireEvent.click(callButton("/bag/resume"));
    await waitFor(() => expect(response("/bag/resume")).toMatch(/request: resume_mode: an integer \(int32\)/));
    expect(call).not.toHaveBeenCalled();
    fireEvent.change(mode, { target: { value: "1" } });
    fireEvent.change(time, { target: { value: '{"sec": 5, "nanosec": 0}' } });
    fireEvent.change(topic, { target: { value: "/rosout" } });
    fireEvent.click(callButton("/bag/resume"));
    await waitFor(() => expect(response("/bag/resume")).toMatch(/return_code: 0\nerror_string: $/));
    expect(call.mock.calls[0][3]).toEqual({ resume_time: { sec: 5, nanosec: 0 }, resume_mode: 1, tracking_topic_name: "/rosout" });
    fireEvent.click(screen.getAllByText("reset fields")[0]);
    expect(mode.value).toBe("2");
  });

  it("a failed call shows the error kind and message; confirm arms the button first; no transport disables everything", async () => {
    shapesByName();
    call.mockRejectedValue(new ServiceCallError("timeout", "/recorder/start", "no reply within 5000 ms"));
    renderWith(<ServicesWidget widget={widget({ services: [{ service: "/recorder/start", confirm: true }] })} />, { graph: graph(), transport });
    await waitFor(() => expect(callButton("/recorder/start").disabled).toBe(false));
    fireEvent.click(callButton("/recorder/start"));
    expect(callButton("/recorder/start").textContent).toBe("confirm?");
    expect(call).not.toHaveBeenCalled();
    fireEvent.click(callButton("/recorder/start"));
    await waitFor(() => expect(response("/recorder/start")).toMatch(/error · .*timeout: no reply within 5000 ms/s));
    expect(row("/recorder/start").querySelector(".service-response.is-err")).not.toBeNull();
    cleanup();
    renderWith(<ServicesWidget widget={widget()} />, { graph: graph() });
    expect([...document.querySelectorAll(".service-head button")].every((b) => (b as HTMLButtonElement).disabled)).toBe(true);
    expect(describe_).toHaveBeenCalledTimes(1); // only the first render (with a transport) resolved a type
  });
});
