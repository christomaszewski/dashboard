import { describe, expect, it } from "vitest";
import { ddsToRosName, parseDdsTypeName, shortTypeName } from "./typeName";

describe("ddsToRosName", () => {
  it("converts message types", () => {
    expect(ddsToRosName("std_msgs::msg::dds_::String_")).toBe("std_msgs/msg/String");
    expect(ddsToRosName("sensor_msgs::msg::dds_::NavSatFix_")).toBe("sensor_msgs/msg/NavSatFix");
  });

  it("converts service types", () => {
    expect(ddsToRosName("type_description_interfaces::srv::dds_::GetTypeDescription_")).toBe(
      "type_description_interfaces/srv/GetTypeDescription",
    );
  });

  it("rejects non-DDS-mangled names", () => {
    expect(ddsToRosName("fleet")).toBeNull();
    expect(ddsToRosName("std_msgs::String")).toBeNull();
    expect(ddsToRosName("std_msgs::msg::String_")).toBeNull(); // missing dds_
    expect(ddsToRosName("std_msgs::msg::dds_::String")).toBeNull(); // missing trailing _
    expect(ddsToRosName("std_msgs::foo::dds_::String_")).toBeNull(); // bad category
  });

  it("parses components", () => {
    expect(parseDdsTypeName("geometry_msgs::msg::dds_::Twist_")).toEqual({
      pkg: "geometry_msgs",
      category: "msg",
      name: "Twist",
    });
  });
});

describe("shortTypeName", () => {
  it("strips the category from full ROS2 names", () => {
    expect(shortTypeName("std_msgs/msg/String")).toBe("std_msgs/String");
  });
  it("passes short (ROS1) names through", () => {
    expect(shortTypeName("std_msgs/String")).toBe("std_msgs/String");
  });
});
