// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TabBar } from "./TabBar";

afterEach(cleanup);

describe("TabBar", () => {
  it("renders nothing for a single tab (the no-`tabs:` default is Home alone)", () => {
    const { container } = render(<TabBar tabs={["home"]} tab="home" navigate={() => undefined} />);
    expect(container.querySelector("nav")).toBeNull();
  });

  it("renders one button per visible tab, marks the current one, and navigates on click", () => {
    const navigate = vi.fn();
    render(<TabBar tabs={["home", "cameras", "debug"]} tab="cameras" navigate={navigate} />);
    const buttons = screen.getAllByRole("button");
    expect(buttons.map((b) => b.textContent)).toEqual(["Home", "Cameras", "Bus debug"]);
    expect(screen.getByRole("button", { name: "Cameras" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("button", { name: "Home" }).getAttribute("aria-current")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Bus debug" }));
    expect(navigate).toHaveBeenCalledWith("debug");
  });
});
