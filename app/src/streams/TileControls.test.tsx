// @vitest-environment jsdom
import { cleanup, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { lifecycle, playback, renderWith } from "../test/harness";
import { TileControls } from "./TileControls";

afterEach(cleanup);

const titles = () => screen.getAllByRole("button").map((b) => b.getAttribute("title"));

describe("TileControls", () => {
  it("renders the record button per advertised transition and the playback strip per advertised control", () => {
    renderWith(<TileControls service={lifecycle("cam0")} playback={playback("cam0")} />);
    expect(titles()).toEqual([
      "activate cam0",
      "pause playback",
      "restart from the beginning",
      "speed ×1 → ×2",
      "looping — click to play once",
    ]);
    expect(document.querySelector(".tile-playback .pill")).toBeNull(); // playing at ×1: no pill
    cleanup();
    renderWith(<TileControls service={undefined} playback={playback("cam0", { state: "paused", controls: ["resume", "restart"] })} />);
    expect(screen.getByText("⏸ 1.5 / 4.0 s")).toBeTruthy();                // held: where it stands
    expect(titles()).toEqual(["resume playback", "restart from the beginning"]);
  });

  it("follows the descriptor, never an assumed state machine", () => {
    renderWith(
      <TileControls
        service={lifecycle("cam0", "active", ["deactivate"])}
        playback={playback("cam0", { state: "finished", controls: ["restart"], loop: false, speed: 0 })}
      />,
    );
    expect(titles()).toEqual(["deactivate cam0", "restart from the beginning"]);
  });

  it("a live camera (no playback token) gets the record strip only; the knobs hide a strip", () => {
    const { unmount } = renderWith(<TileControls service={lifecycle("cam0")} playback={null} />);
    expect(titles()).toEqual(["activate cam0"]);
    unmount();
    renderWith(<TileControls service={lifecycle("cam0")} playback={playback("cam0")} showPlayback={false} />);
    expect(titles()).toEqual(["activate cam0"]);
    cleanup();
    renderWith(<TileControls service={undefined} playback={playback("cam0")} showRecord={false} />);
    expect(titles()).toHaveLength(4);
  });
});
