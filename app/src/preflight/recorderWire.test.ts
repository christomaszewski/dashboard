import { expect, it, vi } from "vitest";
import { buildGraph } from "../ros/graph";
import { callService } from "../services/callService";
import type { Transport } from "../transport/types";

it.each([true, false])("reads is_paused=%s over CDR without a type-description server", async (paused) => {
  const name = "/logger/is_paused";
  const type = "rosbag2_interfaces::srv::dds_::IsPaused_";
  const graph = buildGraph([`@ros2_lv/4/abc/0/1/SS/%/%/logger/%logger%is_paused/${type}/hash/::,10:,:,:,,`]);
  const keyexpr = `4/logger/is_paused/${type}/hash`;
  // CDR encapsulation followed by the boolean, independently of the bundled schema.
  const get = vi.fn(async () => [{ keyexpr, payload: new Uint8Array([0, 1, 0, 0, paused ? 1 : 0]) }]);
  const result = await callService({ get } as unknown as Transport, graph, name, {}, { domainId: 4, timeoutMs: 2000 });
  expect(result.response).toEqual({ paused });
  expect(result.warning).toBeUndefined();
  expect(get).toHaveBeenCalledExactlyOnceWith(keyexpr, expect.objectContaining({
    payload: new Uint8Array([0, 1, 0, 0, 0]), timeoutMs: 2000,
  }));
});
