import { act, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ScrollEdges, scrollEdges } from "./scroll-edges";

describe("scrollEdges (jobauto fork)", () => {
  it("says which edges have more past them", () => {
    expect(scrollEdges({ scrollLeft: 0, scrollWidth: 674, clientWidth: 340 })).toEqual({ start: false, end: true });
    expect(scrollEdges({ scrollLeft: 120, scrollWidth: 674, clientWidth: 340 })).toEqual({ start: true, end: true });
    expect(scrollEdges({ scrollLeft: 334, scrollWidth: 674, clientWidth: 340 })).toEqual({ start: true, end: false });
  });

  it("finds nothing past a row that fits, or a pixel of rounding", () => {
    expect(scrollEdges({ scrollLeft: 0, scrollWidth: 340, clientWidth: 340 })).toEqual({ start: false, end: false });
    expect(scrollEdges({ scrollLeft: 0, scrollWidth: 341, clientWidth: 340 })).toEqual({ start: false, end: false });
  });
});

/** A row of tabs laid out `scrollWidth` wide in a 340 px window. */
function row(scrollWidth: number) {
  return (element: HTMLDivElement | null) => {
    if (!element) return;
    Object.defineProperty(element, "scrollWidth", { configurable: true, value: scrollWidth });
    Object.defineProperty(element, "clientWidth", { configurable: true, value: 340 });
  };
}

describe("ScrollEdges", () => {
  it("fades the row out and points on where there's more, and follows the scrolling", () => {
    const { container } = render(
      <ScrollEdges>
        <div role="tablist" aria-label="Application" ref={row(674)} />
      </ScrollEdges>,
    );
    const wrapper = container.firstElementChild as HTMLElement;
    expect(wrapper).toHaveAttribute("data-scrolls", "end");
    const masked = screen.getByRole("tablist").parentElement!;
    expect(masked.style.maskImage).toMatch(/black calc\(100% - 48px\), transparent calc\(100% - 16px\)\)$/);
    expect(container.querySelectorAll("svg")).toHaveLength(1);

    const list = screen.getByRole("tablist");
    act(() => {
      list.scrollLeft = 334;
      list.dispatchEvent(new Event("scroll"));
    });
    expect(wrapper).toHaveAttribute("data-scrolls", "start");
    expect(masked.style.maskImage).toBe("linear-gradient(to right, transparent 16px, black 48px, black)");
  });

  it("changes nothing on a row that fits", () => {
    const { container } = render(
      <ScrollEdges>
        <div role="tablist" aria-label="Application" ref={row(340)} />
      </ScrollEdges>,
    );
    expect(container.firstElementChild).not.toHaveAttribute("data-scrolls");
    expect(screen.getByRole("tablist").parentElement!.style.maskImage).toBe("");
    expect(container.querySelector("svg")).toBeNull();
  });
});
