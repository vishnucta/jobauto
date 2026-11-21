import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { NavLinks } from "./nav-links";
import { SidebarFrame } from "./sidebar-frame";
import { ThemeToggle } from "./theme-toggle";

let pathname = "/";
vi.mock("next/navigation", () => ({ usePathname: () => pathname, useSearchParams: () => new URLSearchParams() }));
vi.mock("next/link", () => ({
  default: ({ href, ...props }: ComponentProps<"a">) => <a href={href} {...props} />,
}));

let systemDark = false;
// Narrower than 40rem: the sidebar is a drawer (jobauto fork).
let phone = false;
beforeEach(() => {
  systemDark = false;
  phone = false;
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: (query.includes("dark") && systemDark) || (query.includes("40rem") && phone),
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
});
afterEach(() => {
  pathname = "/";
  vi.unstubAllGlobals();
  delete document.documentElement.dataset.theme;
  document.cookie = "dossier_theme=; max-age=0; path=/";
  document.cookie = "dossier_sidebar=; max-age=0; path=/";
  document.cookie = "dossier_sidebar_application=; max-age=0; path=/";
});

function renderSidebar(initialCollapsed = false, initialApplicationCollapsed?: boolean) {
  return render(
    <SidebarFrame initialCollapsed={initialCollapsed} initialApplicationCollapsed={initialApplicationCollapsed} brand={<span>Dossier</span>}>
      <NavLinks />
      <ThemeToggle />
    </SidebarFrame>,
  );
}

describe("SidebarFrame", () => {
  it("collapses to icons, keeps every link named, and remembers it", async () => {
    renderSidebar();
    await userEvent.click(screen.getByRole("button", { name: "Collapse sidebar" }));

    expect(screen.getByRole("complementary")).toHaveAttribute("data-collapsed", "true");
    // The labels are only visually hidden, so links keep their names.
    expect(screen.getByRole("link", { name: "Applications" })).toHaveAttribute("title", "Applications");
    expect(document.cookie).toContain("dossier_sidebar=collapsed");

    await userEvent.click(screen.getByRole("button", { name: "Expand sidebar" }));
    expect(screen.getByRole("complementary")).not.toHaveAttribute("data-collapsed");
    expect(document.cookie).toContain("dossier_sidebar=expanded");
  });

  it("starts collapsed when it was left that way", () => {
    renderSidebar(true);
    expect(screen.getByRole("complementary")).toHaveAttribute("data-collapsed", "true");
  });
});

describe("SidebarFrame on a phone (jobauto fork)", () => {
  beforeEach(() => {
    phone = true;
  });

  // The page beside the drawer, as in the layout.
  function renderShell(initialCollapsed = false) {
    return render(
      <div>
        <SidebarFrame initialCollapsed={initialCollapsed} brand={<span>Dossier</span>}>
          <NavLinks />
        </SidebarFrame>
        <main data-testid="page">The page</main>
      </div>,
    );
  }
  const menu = () => screen.getByRole("button", { name: "Open menu" });
  const isOpen = () => menu().getAttribute("aria-expanded") === "true";

  it("starts closed on every page, from a menu button that names the drawer", () => {
    renderShell();
    expect(menu()).toHaveAttribute("aria-expanded", "false");
    expect(menu()).toHaveAttribute("aria-controls", screen.getByRole("complementary").id);
    expect(screen.getByRole("complementary")).toHaveClass("max-sm:invisible");
  });

  it("opens at full width, whatever the laptop's folded state, and leaves that state alone", async () => {
    document.cookie = "dossier_sidebar=collapsed; path=/";
    renderShell(true);
    expect(screen.getByRole("complementary")).not.toHaveAttribute("data-collapsed");
    await userEvent.click(menu());
    expect(isOpen()).toBe(true);
    expect(screen.getByRole("complementary")).toHaveClass("max-sm:visible");
    expect(screen.getByRole("link", { name: "Applications" })).not.toHaveAttribute("title");
    expect(document.cookie).toContain("dossier_sidebar=collapsed");
  });

  it("keeps focus in the drawer while it's open, and gives it back to the menu button on Esc", async () => {
    renderShell();
    await userEvent.click(menu());
    expect(screen.getByRole("button", { name: "Close menu" })).toHaveFocus();
    // The page beside it can't be reached.
    expect(screen.getByTestId("page").inert).toBe(true);
    await userEvent.keyboard("{Escape}");
    expect(isOpen()).toBe(false);
    expect(screen.getByTestId("page").inert).toBe(false);
    expect(menu()).toHaveFocus();
  });

  it("closes from its close button or a tap beside it", async () => {
    const { container } = renderShell();
    await userEvent.click(menu());
    await userEvent.click(screen.getByRole("button", { name: "Close menu" }));
    expect(isOpen()).toBe(false);

    await userEvent.click(menu());
    await userEvent.click(container.querySelector("[data-drawer-backdrop]")!);
    expect(isOpen()).toBe(false);
    expect(container.querySelector("[data-drawer-backdrop]")).toBeNull();
  });

  it("closes when a link in it is followed, or the page changes", async () => {
    const { rerender } = renderShell();
    await userEvent.click(menu());
    // jsdom can't follow the link; the click is what counts.
    const stay = (event: Event) => event.preventDefault();
    document.addEventListener("click", stay);
    await userEvent.click(screen.getByRole("link", { name: "Applications" }));
    document.removeEventListener("click", stay);
    expect(isOpen()).toBe(false);

    await userEvent.click(menu());
    pathname = "/jobs";
    rerender(
      <div>
        <SidebarFrame initialCollapsed={false} brand={<span>Dossier</span>}>
          <NavLinks />
        </SidebarFrame>
        <main data-testid="page">The page</main>
      </div>,
    );
    expect(isOpen()).toBe(false);
  });

  it("is the laptop's sidebar on a wider window: no drawer to open", async () => {
    phone = false;
    renderShell(true);
    expect(screen.getByRole("complementary")).toHaveAttribute("data-collapsed", "true");
    await userEvent.click(menu());
    expect(isOpen()).toBe(false);
  });
});

describe("ThemeToggle", () => {
  it("offers the other scheme to the system's, then switches and remembers", async () => {
    renderSidebar();
    await userEvent.click(screen.getByRole("button", { name: "Dark mode" }));

    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.cookie).toContain("dossier_theme=dark");
    await userEvent.click(screen.getByRole("button", { name: "Light mode" }));
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("follows a dark system until a choice is made", () => {
    systemDark = true;
    renderSidebar();
    expect(screen.getByRole("button", { name: "Light mode" })).toBeInTheDocument();
  });

  describe("on an application's screen (E27-8)", () => {
    it("starts collapsed there, whatever the other pages do", () => {
      pathname = "/applications/abc";
      renderSidebar(false);
      expect(screen.getByRole("complementary")).toHaveAttribute("data-collapsed", "true");
    });

    it("keeps its own choice: opening it there leaves the other pages alone", async () => {
      pathname = "/applications/abc";
      renderSidebar(false);
      await userEvent.click(screen.getByRole("button", { name: "Expand sidebar" }));
      expect(screen.getByRole("complementary")).not.toHaveAttribute("data-collapsed");
      expect(document.cookie).toContain("dossier_sidebar_application=expanded");
      expect(document.cookie).not.toContain("dossier_sidebar=");
    });

    it("isn't the list or New application", () => {
      for (const path of ["/applications", "/new"]) {
        pathname = path;
        const { unmount } = renderSidebar(false, true);
        expect(screen.getByRole("complementary")).not.toHaveAttribute("data-collapsed");
        unmount();
      }
    });
  });
});
