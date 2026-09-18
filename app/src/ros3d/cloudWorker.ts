import { buildRos2StaticDecoder } from "../schema/decoders/staticDefs";
import { parsePointCloud } from "./pointCloud";
const decoder = buildRos2StaticDecoder("sensor_msgs/msg/PointCloud2");
self.onmessage = async (event: MessageEvent<{ id: number; payload: Uint8Array; maxPoints: number }>) => {
  const { id, payload, maxPoints } = event.data;
  try {
    const reader = await decoder;
    const cloud = parsePointCloud(reader.decode(payload), maxPoints);
    const buffers = [cloud.positions.buffer, ...(cloud.colors ? [cloud.colors.buffer] : []), ...Object.values(cloud.scalars).map((a) => a.buffer)];
    self.postMessage({ id, cloud, warning: reader.lastWarning?.() }, { transfer: buffers });
  } catch (error) { self.postMessage({ id, error: error instanceof Error ? error.message : String(error) }); }
};
