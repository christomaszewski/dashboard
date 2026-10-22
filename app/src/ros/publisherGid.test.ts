import { expect, it } from "vitest";
import { publisherGid } from "./publisherGid";

it("matches native rmw_zenoh GIDs, including buffer backend metadata", async () => {
  // Reference vectors generated with rmw_zenoh's simplified_xxhash3.cpp and the native
  // low64/high64 memcpy used by liveliness::Entity (rolling source 1aae8c3234b9).
  expect(await publisherGid("@ros2_lv/0/z/1/1/MP/%/%/battery/%battery_state/sensor_msgs::msg::dds_::BatteryState_/RIHS01_aa/2:2:1,10"))
    .toBe("294efbc885297d5be5f2b0f2c553b07d");
  expect(await publisherGid("@ros2_lv/1/abcd/2/10/MP/%/%cam/bridge/%cam%image/sensor_msgs::msg::dds_::Image_/RIHS01_test/2:2:1,5/backends:cpu:"))
    .toBe("0ec5f7066ab4ac823df578f5cd02c96a");
});
