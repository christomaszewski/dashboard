// @vitest-environment jsdom
import { cleanup, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { playback, renderWith } from "../test/harness";
import { PlaybackCard } from "./PlaybackCard";

afterEach(cleanup);

describe("PlaybackCard", () => {
  it("shows the state, position, the session being played, and the controls the producer accepts", () => {
    renderWith(
      <PlaybackCard
        service={playback("cam0", {
          source_path: "/data/runs/x/recordings/cam0/cam-20260907-101612",
          session: 1,
          sessions: 3,
        })}
      />,
    );
    expect(screen.getByText("playing")).toBeTruthy();
    expect(screen.getByText("REPLAY")).toBeTruthy();
    expect(screen.getByText("1.5 / 4.0 s")).toBeTruthy();
    expect(screen.getByText("cam-20260907-101612 · session 2/3")).toBeTruthy();
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["pause", "restart", "loop off"]);
    expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe("1");
  });

  it("a finished replay offers restart alone, with no session line when the producer says nothing", () => {
    renderWith(<PlaybackCard service={playback("cam0", { state: "finished", controls: ["restart"] })} />);
    expect(screen.getByText("finished")).toBeTruthy();
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["restart"]);
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(document.querySelector(".playback-session")).toBeNull();
  });
});
