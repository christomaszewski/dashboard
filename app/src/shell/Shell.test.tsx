// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TransportCtx } from "../transport/TransportContext";
import type { Transport } from "../transport/types";
import { RosGraphProvider } from "../ros/RosGraphContext";
import { Shell } from "./Shell";

vi.mock("../home/HomeTab", () => ({ HomeTab: () => <p>home</p> }));

describe("the tab shell", () => {
  let subscribe: ReturnType<typeof vi.fn>;
  let transport: Transport;
  beforeEach(() => {
    vi.useFakeTimers();
    window.location.hash = "#/home";
    subscribe = vi.fn(async () => ({ close: async () => undefined }));
    transport = {
      subscribe: async () => ({ close: async () => undefined }),
      get: async () => [],
      liveliness: { subscribe, get: async () => [] },
      close: async () => undefined,
    } as unknown as Transport;
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("keeps a hidden tab from holding the whole ROS graph open", async () => {
    render(
      <TransportCtx.Provider value={{ transport, status: "connected", error: "", locator: "ws://test" }}>
        <RosGraphProvider><Shell tabs={{ ros: true }} /></RosGraphProvider>
      </TransportCtx.Provider>,
    );
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(subscribe).not.toHaveBeenCalled(); // the ROS tab is mounted, but hidden behind Home
    await act(async () => {
      window.location.hash = "#/ros";
      window.dispatchEvent(new HashChangeEvent("hashchange"));
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(subscribe).toHaveBeenCalledWith("@ros2_lv/**", expect.any(Function));
  });
});
