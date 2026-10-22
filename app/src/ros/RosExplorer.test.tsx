// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { buildGraph } from "./graph";
import { RosExplorer } from "./RosExplorer";
import { RosGraphCtx } from "./RosGraphContext";
import { TopicStore } from "./topicStore";
import type { Sample, Transport } from "../transport/types";
import { encodeAttachment } from "../services/attachment";
import { publisherGid } from "./publisherGid";

const pub = (domain: number, node = "talker", eid = "1") => `@ros2_lv/${domain}/z/0/${eid}/MP/%/%/${node}/%chatter/std_msgs::msg::dds_::String_/RIHS01_a/::,:,:,,:,`;
const service = (domain: number, kind: "SS" | "SC", node: string) =>
  `@ros2_lv/${domain}/z/0/9/${kind}/%/%/${node}/%reset/std_srvs::srv::dds_::Trigger_/RIHS01_s/::,:,:,,:,`;
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
