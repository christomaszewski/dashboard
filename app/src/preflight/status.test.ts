import { describe, expect, it } from "vitest";
import { buildGraph } from "../ros/graph";
import type { HealthService, HealthStatus } from "../health/types";
import { cameraRecordingStatus, healthStatus, matchingHealth, preferLiveIdentities, recorderTarget, rosServiceStatus } from "./status";

const now = 10_000;
function service(rows: Record<string, Partial<HealthStatus>>, over: Partial<HealthService> = {}): HealthService {
  return { key: "fleet/1/svc/cam0/health", vehicleId: "1", instance: "cam0", alive: true, receivedAtMs: now,
    snapshot: { schema_version: 1, service: "camera-service", instance: "cam0", stamp_unix_ns: 0, level: 0,
      status: Object.entries(rows).map(([component, row]) => ({ name: `cam0: ${component}`, level: 0, message: "OK", hardware_id: "", values: {}, ...row })) }, ...over };
}
const row = (values: HealthStatus["values"], level: HealthStatus["level"] = 0) => ({ values, level });
export const srvToken = (name: string, domain = 0, type = "rosbag2_interfaces::srv::dds_::IsPaused_", zid = "abc") =>
  `@ros2_lv/${domain}/${zid}/0/${name.replaceAll("/", "_")}/SS/%/%/recorder/${name.replaceAll("/", "%")}/${domain === 99 ? "other::srv::dds_::Type_" : type}/hash/::,10:,:,:,,`;

describe("preflight verdicts", () => {
  it("maps diagnostics to green, yellow and red with useful messages", () => {
    expect(healthStatus(service({ gps: {} }), undefined, now).level).toBe("ok");
    const gps = healthStatus(service({ gps: { level: 1, message: "Waiting for GPS lock" } }), undefined, now);
    expect(gps.level).toBe("warn"); expect(gps.details.join()).toContain("Waiting for GPS lock");
    expect(healthStatus(service({ gps: { level: 2 } }), undefined, now).level).toBe("err");
  });
  it("never shows stale, missing or offline diagnostics as healthy", () => {
    expect(healthStatus(service({ gps: {} }), undefined, now + 6000).summary).toBe("Health reporter silent");
    expect(healthStatus(service({ gps: {} }, { alive: false }), undefined, now).level).toBe("err");
    expect(healthStatus(service({ gps: row({ "health.sample_age_s": 10 }) }), undefined, now).level).toBe("err");
    expect(healthStatus(service({ gps: {} }), ["gps", "imu"], now).summary).toBe("Required diagnostics missing");
    expect(healthStatus(service({}), undefined, now).level).toBe("err");
    expect(healthStatus(service({ gps: row({ "health.availability": "paused" }) }), undefined, now).level).toBe("warn");
    const failed = healthStatus(service({ gps: row({ "health.error": "read failed" }) }), undefined, now);
    expect(failed.level).toBe("warn"); expect(failed.details.join()).toContain("read failed");
  });
  it("filters configured components and resolves exact vehicle identity", () => {
    const health = service({ gps: {}, radio: { level: 2 } });
    expect(healthStatus(health, ["gps"], now).level).toBe("ok");
    const second = { ...health, vehicleId: "2", key: "fleet/2/svc/cam0/health" };
    expect(matchingHealth([health, second], "cam0")).toHaveLength(2);
    expect(matchingHealth([health, second], "2/cam0")).toEqual([second]);
    expect(matchingHealth([health, second], health.key)).toEqual([health]);
  });
  it.each(["native", "ros2"] as const)("prefers a fleet-keyed %s reporter over anonymous ROS names", source => {
    const fleet = service({ stream: {} }, { source });
    const generic = service({ stream: {} }, { key: "ros2/4/%2Fother_topic/cam0", vehicleId: "ROS domain 4", source: "ros2" });
    const all = [generic, fleet];
    expect(matchingHealth(all, "cam0")).toEqual([fleet]);
    expect(all).toEqual([generic, fleet]); // selection must not remove discovery rows
    expect(matchingHealth(all, "1/cam0")).toEqual([fleet]);
    expect(matchingHealth(all, fleet.key)).toEqual([fleet]);
    expect(matchingHealth(all, generic.key)).toEqual([generic]);
  });
  it("keeps offline fleet health instead of silently selecting a live generic ROS reporter", () => {
    const offline = service({ stream: {} }, { alive: false });
    const generic = service({ stream: {} }, { key: "ros2/4/%2Fother_topic/cam0", vehicleId: "ROS domain 4", source: "ros2" });
    const matches = preferLiveIdentities(matchingHealth([offline, generic], "cam0"), "cam0");
    expect(matches).toEqual([offline]);
    expect(healthStatus(matches[0], undefined, now).summary).toBe("Service offline");
  });
  it("retains real fleet collisions and every generic-only topic/domain collision", () => {
    const first = service({ stream: {} });
    const second = service({ stream: {} }, { key: "fleet/2/svc/cam0/health", vehicleId: "2" });
    const generic = service({ stream: {} }, { key: "ros2/4/%2Fother_topic/cam0", vehicleId: "ROS domain 4", source: "ros2" });
    expect(matchingHealth([first, generic, second], "cam0")).toEqual([first, second]);
    const otherTopic = { ...generic, key: "ros2/4/%2Fdiagnostics/cam0" };
    const otherDomain = { ...generic, key: "ros2/8/%2Fother_topic/cam0", vehicleId: "ROS domain 8" };
    expect(matchingHealth([generic], "cam0")).toEqual([generic]);
    expect(matchingHealth([generic, otherTopic, otherDomain], "cam0")).toEqual([generic, otherTopic, otherDomain]);
    expect(matchingHealth([first, generic, otherDomain], "ROS domain 4/cam0")).toEqual([generic]);
  });
  it("ignores retained offline identities for short names without hiding explicit or live collisions", () => {
    const resolve = (services: HealthService[], ref: string) => preferLiveIdentities(matchingHealth(services, ref), ref);
    const offline = service({ stream: {} }, { alive: false });
    const live = { ...offline, key: "fleet/2/svc/cam0/health", vehicleId: "2", alive: true };
    expect(resolve([offline, live], "cam0")).toEqual([live]);
    expect(resolve([offline, live], "1/cam0")).toEqual([offline]);
    expect(resolve([offline, live], offline.key)).toEqual([offline]);
    const stale = { ...offline, alive: true, receivedAtMs: 0 };
    expect(resolve([stale, live], "cam0")).toEqual([stale, live]);
    const secondOffline = { ...live, alive: false };
    expect(resolve([offline, secondOffline], "cam0")).toEqual([offline, secondOffline]);
    expect(resolve([offline], "cam0")).toEqual([offline]);
  });
  it("requires current capture and recorded frames for camera recording green", () => {
    const camera = (state = "active", frames = 30) => service({ stream: {}, recording: row({ state, enabled: true, frames }) });
    expect(cameraRecordingStatus(camera(), now).level).toBe("ok");
    expect(cameraRecordingStatus(camera("inactive"), now).level).toBe("warn");
    expect(cameraRecordingStatus(camera("activating", 0), now).level).toBe("warn");
    expect(cameraRecordingStatus(camera("active", 0), now).summary).toBe("Waiting for recorded frames");
    expect(cameraRecordingStatus(camera(), now + 6000).level).toBe("err");
    expect(cameraRecordingStatus(service({ stream: { level: 2, message: "source stalled" }, recording: row({ state: "active", frames: 30 }) }), now).level).toBe("err");
    expect(cameraRecordingStatus(service({ stream: {}, recording: row({ state: "active", enabled: false, frames: 30 }) }), now).summary).toBe("Recording disabled");
    expect(cameraRecordingStatus(service({ stream: {} }), now).level).toBe("err");
  });
});

describe("ROS targets", () => {
  const base = "/bag/recorder";
  const tokens = (domain = 0) => [srvToken(`${base}/pause`, domain), srvToken(`${base}/is_paused`, domain)];
  it("uses domain-scoped availability, never client-only graph entries", () => {
    expect(rosServiceStatus(buildGraph([]), "/control").level).toBe("err");
    expect(rosServiceStatus(buildGraph([srvToken("/control").replace("/SS/", "/SC/")]), "/control").level).toBe("err");
    const graph = buildGraph([srvToken("/control", 0), srvToken("/control", 1)]);
    expect(rosServiceStatus(graph, "/control").level).toBe("err");
    expect(rosServiceStatus(graph, "/control", 1).level).toBe("ok");
    expect(rosServiceStatus(graph, "/control", 2).level).toBe("err");
  });
  it("rejects missing, ambiguous, wrong-type and player targets before querying", () => {
    expect(recorderTarget(buildGraph(tokens()), base).error).toBeUndefined();
    expect(recorderTarget(buildGraph([]), base).error?.level).toBe("err");
    const multi = buildGraph([...tokens(), ...tokens(1)]);
    expect(recorderTarget(multi, base).error?.summary).toBe("Ambiguous recorder");
    expect(recorderTarget(multi, base, 1).error).toBeUndefined();
    expect(recorderTarget(buildGraph([...tokens(), srvToken(`${base}/seek`)]), base).error?.level).toBe("err");
    expect(recorderTarget(buildGraph(tokens(99)), base).error?.summary).toBe("Unexpected recorder service type");
  });
});
