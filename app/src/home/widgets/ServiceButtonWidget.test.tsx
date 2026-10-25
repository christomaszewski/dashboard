// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServiceButtonWidgetConfig } from "../../config/schema";
import { EMPTY_GRAPH, type RosGraph, type ServiceEntry } from "../../ros/graph";
import { callService, describeCallError, ServiceCallError } from "../../services/callService";
import type { Transport } from "../../transport/types";
import { TransportError } from "../../transport/reconnecting";
import { renderWith } from "../../test/harness";
import { ServiceButtonWidget } from "./ServiceButtonWidget";

vi.mock("../../services/callService", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../services/callService")>()),
  callService: vi.fn(),
}));
const call = vi.mocked(callService);
afterEach(cleanup);
beforeEach(() => {
  call.mockReset();
});

const graph: RosGraph = {
  ...EMPTY_GRAPH,
  services: [{ name: "/logger/snapshot", typeName: "std_srvs/srv/Trigger", servers: ["n"], clients: [] } as unknown as ServiceEntry],
};
const widget: ServiceButtonWidgetConfig = { type: "service_button", label: "Snapshot", service: "/logger/snapshot" } as ServiceButtonWidgetConfig;
const transport = {} as Transport;

describe("a service button on a lossy link", () => {
  it("says the outcome is unknown after a timeout, and makes the retry deliberate", async () => {
    call.mockRejectedValueOnce(new ServiceCallError("timeout", "/logger/snapshot", "no reply within 5000 ms"));
    renderWith(<ServiceButtonWidget widget={widget} />, { graph, transport });
    fireEvent.click(screen.getByRole("button", { name: "Snapshot" }));
    await waitFor(() => expect(screen.getByText(/^outcome unknown — it may have run; check before retrying/)).toBeTruthy());
    expect(screen.getByText(/outcome unknown/).className).toContain("is-warn");
    // The next press asks first; only the one after that calls again.
    fireEvent.click(screen.getByRole("button", { name: "Snapshot" }));
    expect(screen.getByRole("button", { name: "retry? may repeat" })).toBeTruthy();
    expect(call).toHaveBeenCalledTimes(1);
    call.mockResolvedValueOnce({ response: { success: true, message: "saved" }, raw: new Uint8Array(), serverKeyexpr: "k", rttMs: 3 });
    fireEvent.click(screen.getByRole("button", { name: "retry? may repeat" }));
    await waitFor(() => expect(screen.getByText("success — saved")).toBeTruthy());
    expect(call).toHaveBeenCalledTimes(2);
  });

  it("keeps a plain error for calls that never reached the vehicle", async () => {
    call.mockRejectedValueOnce(new ServiceCallError("disconnected", "/logger/snapshot", "link reconnecting", { outcome: "not-sent" }));
    renderWith(<ServiceButtonWidget widget={widget} />, { graph, transport });
    fireEvent.click(screen.getByRole("button", { name: "Snapshot" }));
    await waitFor(() => expect(screen.getByText("disconnected: link reconnecting").className).toContain("is-err"));
  });
});

describe("call outcomes", () => {
  it("tell a call that never left from one that may have run", () => {
    expect(new ServiceCallError("no-server", "s", "m").outcome).toBe("not-sent");
    expect(new ServiceCallError("reply-error", "s", "m").outcome).toBe("refused");
    expect(new ServiceCallError("timeout", "s", "m").outcome).toBe("unknown");
    expect(new ServiceCallError("decode-failed", "s", "m").outcome).toBe("unknown");
    expect(describeCallError(new ServiceCallError("reply-error", "s", "bad request"))).toEqual({ text: "reply-error: bad request", unknown: false });
    expect(new TransportError("disconnected", "x").sent).toBe(true);
    expect(new TransportError("disconnected", "x", false).sent).toBe(false);
  });
});
