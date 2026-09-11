// @vitest-environment jsdom
// (gstwebrtc-api touches `window` at import; the function under test is pure.)
import { describe, expect, it } from "vitest";
import { summarizeStats } from "./gstwebrtc";

// A trimmed RTCStatsReport the way Chrome lays it out: entries keyed by id, the transport pointing at
// its selected candidate pair, the pair pointing at its two candidates.
function chromeReport() {
  return [
    { id: "IT01", type: "inbound-rtp", kind: "video", packetsReceived: 1234, packetsLost: 5, nackCount: 3, pliCount: 1,
      framesReceived: 400, framesDecoded: 398, framesDropped: 2, freezeCount: 1, totalFreezesDuration: 0.9,
      jitterBufferDelay: 24.4, jitterBufferEmittedCount: 400 },
    { id: "T01", type: "transport", selectedCandidatePairId: "CP01" },
    { id: "CP01", type: "candidate-pair", localCandidateId: "L1", remoteCandidateId: "R1", currentRoundTripTime: 0.003, nominated: true },
    { id: "CP02", type: "candidate-pair", localCandidateId: "L2", remoteCandidateId: "R1", currentRoundTripTime: 0.2 },
    { id: "L1", type: "local-candidate", protocol: "udp", candidateType: "host" },
    { id: "L2", type: "local-candidate", protocol: "tcp", candidateType: "host" },
    { id: "R1", type: "remote-candidate", protocol: "udp", candidateType: "host" },
  ];
}

describe("summarizeStats", () => {
  it("curates inbound-rtp video + the transport's selected candidate pair", () => {
    expect(summarizeStats(chromeReport())).toEqual({
      packetsReceived: 1234, packetsLost: 5, nackCount: 3, pliCount: 1,
      framesReceived: 400, framesDecoded: 398, framesDropped: 2, freezeCount: 1, totalFreezesDuration: 0.9,
      jitterBufferDelay: 24.4, jitterBufferEmittedCount: 400,
      transport: "udp host->host", currentRoundTripTime: 0.003,
    });
  });

  it("falls back to the nominated/selected pair when there is no transport entry (Firefox)", () => {
    const report = chromeReport().filter((s) => s.type !== "transport"); // CP01 carries `nominated`
    expect(summarizeStats(report)?.transport).toBe("udp host->host");
    expect(summarizeStats(report)?.currentRoundTripTime).toBe(0.003);
  });

  it("names a TCP pair as such — the Docker-Desktop / relay tell", () => {
    const report = chromeReport();
    report.find((s) => s.id === "T01")!.selectedCandidatePairId = "CP02";
    expect(summarizeStats(report)?.transport).toBe("tcp host->host");
  });

  it("returns null when nothing receive-side exists yet (pre-ICE) and ignores audio", () => {
    expect(summarizeStats([])).toBeNull();
    expect(summarizeStats([{ id: "x", type: "inbound-rtp", kind: "audio", packetsReceived: 9 }])).toBeNull();
    expect(summarizeStats([{ id: "x", type: "inbound-rtp", kind: "video" }])).toEqual({});
  });
});
