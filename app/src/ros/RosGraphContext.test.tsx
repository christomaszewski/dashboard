// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TransportCtx } from "../transport/TransportContext";
import type { Transport } from "../transport/types";
import { TabActivity } from "../shell/TabActivity";
import { RosGraphProvider, useRosGraphContext } from "./RosGraphContext";

function Needs({ need }: { need: boolean }) {
  useRosGraphContext(need);
  return null;
}

describe("the ROS graph subscription", () => {
  let subscribe: ReturnType<typeof vi.fn>;
  let close: ReturnType<typeof vi.fn>;
  let transport: Transport;
  beforeEach(() => {
    vi.useFakeTimers();
    close = vi.fn(async () => undefined);
    subscribe = vi.fn(async () => ({ close }));
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
  const app = (children: React.ReactNode) => (
    <TransportCtx.Provider value={{ transport, status: "connected", error: "", locator: "ws://test" }}>
      <RosGraphProvider>{children}</RosGraphProvider>
    </TransportCtx.Provider>
  );

  it("is opened only while a visible view needs it, and kept through a short absence", async () => {
    const view = render(app(<Needs need={false} />));
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(subscribe).not.toHaveBeenCalled();
    view.rerender(app(<><Needs need={false} /><Needs need /></>));
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(subscribe).toHaveBeenCalledTimes(1);
    view.rerender(app(<Needs need={false} />));
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(close).not.toHaveBeenCalled(); // a tab flip back within the linger keeps it
    await act(async () => { await vi.advanceTimersByTimeAsync(11_000); });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("is not opened for a view on a hidden tab", async () => {
    render(app(<TabActivity.Provider value={false}><Needs need /></TabActivity.Provider>));
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(subscribe).not.toHaveBeenCalled();
  });
});
