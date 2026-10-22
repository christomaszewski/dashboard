// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { buildGraph, type RosGraph } from "./graph";
import { RosExplorer } from "./RosExplorer";
import { RosGraphCtx } from "./RosGraphContext";
import { TopicStore } from "./topicStore";
import type { Sample, Transport } from "../transport/types";
import { encodeAttachment } from "../services/attachment";
import { publisherGid } from "./publisherGid";

const pub = (domain: number, node = "talker", eid = "1") => `@ros2_lv/${domain}/z/0/${eid}/MP/%/%/${node}/%chatter/std_msgs::msg::dds_::String_/RIHS01_a/::,:,:,,:,`;
const service = (domain: number, kind: "SS" | "SC", node: string) =>
  `@ros2_lv/${domain}/z/0/9/${kind}/%/%/${node}/%reset/std_srvs::srv::dds_::Trigger_/RIHS01_s/::,:,:,,:,`;
const node = (name: string) => `@ros2_lv/0/z/0/0/NN/%/%/${name}`;
afterEach(cleanup);

it("shows topic endpoints and service servers/clients separately in each domain", () => {
  const graph = buildGraph([pub(0), pub(1, "second_domain"), pub(0, "listener").replace("/MP/", "/MS/"),
    service(0, "SS", "server"), service(0, "SC", "client"), service(1, "SS", "other_server")]);
  render(<RosGraphCtx.Provider value={{ graph, store: null, resolver: null }}><RosExplorer /></RosGraphCtx.Provider>);
  const topicRow = screen.getByText("/talker").closest("tr")!;
  expect(within(topicRow).getByText("/listener")).toBeTruthy();
  expect(within(topicRow).getByText("0")).toBeTruthy();
  const serviceRow = screen.getByText("/server").closest("tr")!;
  expect(within(serviceRow).getByText("/client")).toBeTruthy();
  expect(within(serviceRow).queryByText("/other_server")).toBeNull();
});

it("does not traverse a hidden graph and renders the latest graph on first activation", () => {
  const first = buildGraph([pub(0)]);
  const latest = buildGraph([pub(1, "latest_publisher"), node("latest_node"), service(1, "SS", "latest_server")]);
  const reads = vi.fn();
  const watched = Object.fromEntries(Object.entries(latest).map(([key, value]) => [key, {
    enumerable: true, get: () => { reads(); return value; },
  }]));
  const graph = Object.defineProperties({}, watched) as RosGraph;
  const content = (current: RosGraph, active: boolean) =>
    <RosGraphCtx.Provider value={{ graph: current, store: null, resolver: null }}><RosExplorer active={active} /></RosGraphCtx.Provider>;
  const view = render(content(first, false));
  view.rerender(content(graph, false));
  expect(reads).not.toHaveBeenCalled();
  expect(screen.queryByText("ROS graph")).toBeNull();
  view.rerender(content(graph, true));
  expect(screen.getByText("/latest_publisher")).toBeTruthy();
  expect(screen.getByText("/latest_node")).toBeTruthy();
  expect(screen.getByText("/latest_server")).toBeTruthy();
  expect(screen.queryByText("/talker")).toBeNull();
});

it("retains open details and skips hidden table work across graph changes", () => {
  const first = buildGraph([pub(0), node("old_node"), service(0, "SS", "old_server")]);
  const latest = buildGraph([pub(0, "new_publisher"), node("new_node"), service(0, "SS", "new_server")]);
  const endpointName = vi.fn(() => "/new_publisher");
  Object.defineProperty(latest.topics[0].publishers[0], "nodeFq", { get: endpointName });
  const content = (graph: RosGraph, active: boolean) =>
    <RosGraphCtx.Provider value={{ graph, store: null, resolver: null }}><RosExplorer active={active} /></RosGraphCtx.Provider>;
  const view = render(content(first, true));
  const nodes = screen.getByText("Nodes (1)").closest("details")!;
  const services = screen.getByText("Services (1)").closest("details")!;
  nodes.open = true;
  services.open = true;
  view.rerender(content(first, false));
  view.rerender(content(latest, false));
  expect(endpointName).not.toHaveBeenCalled();
  expect(screen.getByText("/talker")).toBeTruthy();
  expect(screen.queryByText("/new_publisher")).toBeNull();
  expect(nodes.open && services.open).toBe(true);
  view.rerender(content(latest, true));
  expect(screen.getByText("/new_publisher")).toBeTruthy();
  expect(screen.getByText("/new_node")).toBeTruthy();
  expect(screen.getByText("/new_server")).toBeTruthy();
  expect(screen.getByText("Nodes (1)").closest("details")).toBe(nodes);
  expect(screen.getByText("Services (1)").closest("details")).toBe(services);
  expect(nodes.open && services.open).toBe(true);
});

it("inspects the selected domain, attributes two publishers, and releases when deselected", async () => {
  const graph = buildGraph([pub(0), pub(1), pub(1, "other_talker", "2")]);
  const selected = graph.topics.find((t) => t.domainId === 1)!;
  let receive: ((sample: Sample) => void) | undefined;
  const close = vi.fn(async () => undefined);
  const transport: Transport = {
    subscribe: vi.fn(async (_key, cb) => { receive = cb; return { close }; }),
    get: async () => [], close: async () => undefined,
    liveliness: { subscribe: async () => ({ close }), get: async () => [] },
  };
  const resolver = { resolve: async () => ({ decode: () => ({ data: "hello" }) }) };
  const store = new TopicStore({ transport, resolver, flushMs: 10, lingerMs: 0 });
  const view = render(<RosGraphCtx.Provider value={{ graph, store, resolver }}><RosExplorer /></RosGraphCtx.Provider>);
  try {
    expect(transport.subscribe).not.toHaveBeenCalled();
    fireEvent.click(screen.getAllByRole("button", { name: "/chatter" })[1]);
    await waitFor(() => expect(transport.subscribe).toHaveBeenCalledWith(selected.dataKeyexpr, expect.any(Function)));
    for (let i = 0; i < selected.publishers.length; i++) {
      const hex = await publisherGid(selected.publishers[i].keyexpr);
      const attachment = encodeAttachment({ gid: Uint8Array.from(hex.match(/../g)!, (b) => parseInt(b, 16)),
        sequenceNumber: 1n, sourceTimestamp: 0n });
      for (let j = 0; j <= i; j++) receive!({ keyexpr: selected.dataKeyexpr, kind: "put", payload: new Uint8Array(100), attachment });
    }
    await waitFor(() => {
      const table = screen.getByText("All publishers").closest("table")!;
      expect(within(within(table).getByText("All publishers").closest("tr")!).getAllByRole("cell")[1].textContent).toBe("3");
      expect(within(within(table).getByText("/talker").closest("tr")!).getAllByRole("cell")[1].textContent).toBe("1");
      expect(within(within(table).getByText("/other_talker").closest("tr")!).getAllByRole("cell")[1].textContent).toBe("2");
      expect(within(table).queryByText(/Unmatched publisher/)).toBeNull();
    });
    fireEvent.click(screen.getAllByRole("button", { name: "/chatter" })[1]);
    await waitFor(() => expect(close).toHaveBeenCalledTimes(1));
    expect(screen.queryByText("All publishers")).toBeNull();
  } finally { view.unmount(); store.closeAll(); }
});

it("keeps a hidden inspector subscribed to live data and releases a topic removed from the live graph", async () => {
  const first = buildGraph([pub(0)]);
  const changed = buildGraph([pub(0), pub(0, "another_publisher", "2")]);
  let receive: ((sample: Sample) => void) | undefined;
  const close = vi.fn(async () => undefined);
  const transport: Transport = {
    subscribe: vi.fn(async (_key, cb) => { receive = cb; return { close }; }),
    get: async () => [], close: async () => undefined,
    liveliness: { subscribe: async () => ({ close }), get: async () => [] },
  };
  const resolver = { resolve: async () => ({ decode: (bytes: Uint8Array) => ({ data: new TextDecoder().decode(bytes) }) }) };
  const store = new TopicStore({ transport, resolver, flushMs: 10, lingerMs: 0 });
  const content = (graph: RosGraph, active: boolean) =>
    <RosGraphCtx.Provider value={{ graph, store, resolver }}><RosExplorer active={active} /></RosGraphCtx.Provider>;
  const view = render(content(first, true));
  try {
    fireEvent.click(screen.getByRole("button", { name: "/chatter" }));
    await waitFor(() => expect(transport.subscribe).toHaveBeenCalledTimes(1));
    view.rerender(content(changed, false));
    receive!({ keyexpr: first.topics[0].dataKeyexpr, kind: "put", payload: new TextEncoder().encode("hidden update") });
    await waitFor(() => expect(screen.getByText('"hidden update"')).toBeTruthy());
    expect(close).not.toHaveBeenCalled();
    view.rerender(content(changed, true));
    expect(screen.getByRole("button", { name: "/chatter" }).getAttribute("aria-expanded")).toBe("true");
    expect(transport.subscribe).toHaveBeenCalledTimes(1);
    expect(close).not.toHaveBeenCalled();
    view.rerender(content(buildGraph([]), false));
    await waitFor(() => expect(close).toHaveBeenCalledTimes(1));
    expect(screen.queryByText("All publishers")).toBeNull();
    view.rerender(content(buildGraph([]), true));
    expect(screen.queryByRole("button", { name: "/chatter" })).toBeNull();
  } finally { view.unmount(); store.closeAll(); }
});
