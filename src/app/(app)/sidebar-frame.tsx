"use client";

import { Menu, PanelLeftClose, PanelLeftOpen, X } from "lucide-react";
import { usePathname } from "next/navigation";
import { createContext, use, useEffect, useId, useRef, useState, useSyncExternalStore, type MouseEvent, type ReactNode } from "react";

import { cn } from "@/lib/cn";
import { APPLICATION_SIDEBAR_COOKIE, rememberPreference, SIDEBAR_COOKIE } from "@/lib/ui-preferences";

const CollapsedContext = createContext<{ collapsed: boolean; expand: () => void }>({ collapsed: false, expand: () => {} });

/** Whether the sidebar is collapsed to its icons, for the parts that need more than CSS. */
export function useSidebarCollapsed(): boolean {
  return use(CollapsedContext).collapsed;
}

/** Opens a collapsed sidebar, for a part that needs its full width (the update notice). */
export function useExpandSidebar(): () => void {
  return use(CollapsedContext).expand;
}

/** An application's own screen, where the sidebar keeps its own state (E27-8); not the list, nor New application. */
const isApplicationScreen = (pathname: string | null) => /^\/applications\/[^/]+/.test(pathname ?? "");

/** A phone: narrower than Tailwind's `sm` (40rem, 640 px), the width the `max-sm:` classes below use (jobauto fork). */
const PHONE_QUERY = "(width < 40rem)";

function subscribePhone(listener: () => void) {
  const query = window.matchMedia?.(PHONE_QUERY);
  query?.addEventListener("change", listener);
  return () => query?.removeEventListener("change", listener);
}

/** Whether the window is phone-wide; the server can't tell, so it renders the laptop's sidebar and CSS keeps it off a phone until hydration. */
function usePhone(): boolean {
  return useSyncExternalStore(
    subscribePhone,
    () => window.matchMedia?.(PHONE_QUERY).matches ?? false,
    () => false,
  );
}

/**
 * The sidebar's frame, collapsible to a strip of icons.
 * The choice is kept in a cookie, so the server renders the next page the
 * same way. An application's screen has its own, collapsed until the user
 * opens it there, so the document gets the room (E27-8); toggling one never
 * changes the other. Inside, `group-data-collapsed/sidebar:` variants hide
 * what doesn't fit, so the server-rendered parts need no state of their own.
 *
 * On a phone (jobauto fork) the sidebar is a drawer instead: closed on every
 * page, opened from the menu button in a slim bar across the top, always at
 * full width, and closed again by a link, a tap beside it, Esc or its close
 * button. While it's open the page behind is inert, so focus and a screen
 * reader stay in it. The laptop's collapsed state is left as it was.
 */
export function SidebarFrame({
  initialCollapsed,
  initialApplicationCollapsed = true,
  brand,
  children,
}: {
  initialCollapsed: boolean;
  /** On an application's screen. */
  initialApplicationCollapsed?: boolean;
  /** The logo, which the expand button replaces on hover while collapsed. */
  brand: ReactNode;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const onApplication = isApplicationScreen(pathname);
  const phone = usePhone();
  const [elsewhere, setElsewhere] = useState(initialCollapsed);
  const [onScreen, setOnScreen] = useState(initialApplicationCollapsed);
  // The drawer is open on the page it was opened on, so going to another closes it.
  const [openOn, setOpenOn] = useState<string | null>(null);
  const drawerOpen = phone && openOn !== null && openOn === pathname;
  const collapsed = !phone && (onApplication ? onScreen : elsewhere);
  const change = (next: boolean) => {
    (onApplication ? setOnScreen : setElsewhere)(next);
    rememberPreference(onApplication ? APPLICATION_SIDEBAR_COOKIE : SIDEBAR_COOKIE, next ? "collapsed" : "expanded");
  };
  const toggle = () => change(!collapsed);
  const Icon = collapsed ? PanelLeftOpen : PanelLeftClose;

  const drawerId = useId();
  const aside = useRef<HTMLElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);

  // While the drawer is open: the page beside it inert, focus in it, Esc closes it.
  useEffect(() => {
    const drawer = aside.current;
    const menu = menuButton.current;
    if (!drawerOpen || !drawer) return;
    const others = [...(drawer.parentElement?.children ?? [])].filter(
      (element): element is HTMLElement => element instanceof HTMLElement && element !== drawer && !element.hasAttribute("data-drawer-backdrop") && !element.inert,
    );
    for (const element of others) element.inert = true;
    closeButton.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      // A dialog opened from the drawer (Jump to) closes first.
      if (event.key === "Escape" && !event.defaultPrevented) setOpenOn(null);
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      for (const element of others) element.inert = false;
      // Back to the menu button, unless a link took focus somewhere else.
      if (!document.activeElement || document.activeElement === document.body || drawer.contains(document.activeElement)) menu?.focus();
    };
  }, [drawerOpen]);

  // A link in the drawer closes it, even one to the page already open (a status under Applications).
  const closeOnLink = (event: MouseEvent) => {
    if (drawerOpen && event.target instanceof Element && event.target.closest("a[href]")) setOpenOn(null);
  };

  return (
    <CollapsedContext value={{ collapsed, expand: () => change(false) }}>
      {/* The phone's bar across the top, with the menu button (jobauto fork). */}
      <div className="sticky top-0 z-30 flex h-12 shrink-0 items-center gap-2 border-b border-line bg-sidebar px-2 sm:hidden">
        <button
          ref={menuButton}
          type="button"
          onClick={() => setOpenOn(pathname)}
          aria-label="Open menu"
          aria-expanded={drawerOpen}
          aria-controls={drawerId}
          className="grid size-10 shrink-0 place-items-center rounded-control text-ink hover:bg-hover"
        >
          <Menu size={20} aria-hidden="true" />
        </button>
        <div className="flex min-w-0 items-center gap-2 [&_svg]:size-[26px]">{brand}</div>
      </div>
      {drawerOpen && <div data-drawer-backdrop="" aria-hidden="true" onClick={() => setOpenOn(null)} className="fixed inset-0 z-40 bg-black/40 sm:hidden" />}
      <aside
        ref={aside}
        id={drawerId}
        aria-label="Sidebar"
        data-collapsed={collapsed || undefined}
        onClick={closeOnLink}
        className={cn(
          "group/sidebar sticky top-0 flex h-screen shrink-0 flex-col self-start overflow-x-hidden overflow-y-auto border-r border-line bg-sidebar motion-safe:transition-[width] motion-safe:duration-200",
          collapsed ? "w-[60px]" : "w-[264px]",
          // On a phone, a drawer over the page, hidden (and out of the tab order) while closed.
          // Shown at once when it opens, so its close button can take focus; hidden once it has slid away.
          "max-sm:fixed max-sm:inset-y-0 max-sm:left-0 max-sm:z-40 max-sm:h-dvh max-sm:w-[min(288px,85vw)] max-sm:shadow-dialog",
          drawerOpen
            ? "max-sm:visible max-sm:translate-x-0 max-sm:motion-safe:transition-[translate]"
            : "max-sm:invisible max-sm:-translate-x-full max-sm:motion-safe:transition-[translate,visibility]",
        )}
      >
        <div
          className={cn(
            "group/header relative flex items-center gap-2 border-b border-line",
            collapsed ? "justify-center px-1 py-3" : "pt-3 pr-3 pb-4 pl-4",
          )}
        >
          <div
            className={cn(
              "flex min-w-0 flex-1 items-center gap-2",
              // Collapsed, the logo and the expand button share one slot.
              collapsed &&
                "flex-none group-hover/header:opacity-0 group-has-[button:focus-visible]/header:opacity-0 motion-safe:transition-opacity",
            )}
          >
            {brand}
          </div>
          <button
            type="button"
            onClick={toggle}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            className={cn(
              "grid size-7 shrink-0 place-items-center rounded-control text-muted hover:bg-hover hover:text-ink max-sm:hidden",
              collapsed &&
                "absolute inset-0 m-auto size-8 bg-surface opacity-0 group-hover/header:opacity-100 focus-visible:opacity-100 motion-safe:transition-opacity",
            )}
          >
            <Icon size={16} aria-hidden="true" />
          </button>
          {/* The drawer's own close button, on a phone. */}
          <button
            ref={closeButton}
            type="button"
            onClick={() => setOpenOn(null)}
            aria-label="Close menu"
            className="grid size-9 shrink-0 place-items-center rounded-control text-muted hover:bg-hover hover:text-ink sm:hidden"
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>
        {children}
      </aside>
    </CollapsedContext>
  );
}
