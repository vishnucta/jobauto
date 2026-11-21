"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

import { cn } from "@/lib/cn";

/** How far the row fades out at an edge with more past it, and the clear strip at the very edge where the arrow sits. */
const FADE = 48;
const CLEAR = 16;

type Edges = { start: boolean; end: boolean };

/** Which edges of a sideways scroller have more past them. */
export function scrollEdges(row: Pick<HTMLElement, "scrollLeft" | "scrollWidth" | "clientWidth">): Edges {
  const rest = row.scrollWidth - row.clientWidth;
  // A pixel either way is rounding, not more to see.
  return { start: rest > 1 && row.scrollLeft > 1, end: rest > 1 && row.scrollLeft < rest - 1 };
}

/** The mask that fades the row out at the edges with more past them. */
function fadeMask({ start, end }: Edges): string | undefined {
  if (!start && !end) return undefined;
  return `linear-gradient(to right, ${start ? `transparent ${CLEAR}px, black ${FADE}px` : "black"}, ${end ? `black calc(100% - ${FADE}px), transparent calc(100% - ${CLEAR}px)` : "black"})`;
}

/**
 * Shows that a row scrolls sideways (jobauto fork): where there's more past
 * an edge, the row fades out there and a small arrow points on, e.g. the
 * application's tabs on a phone. `children` is the scrolling row itself.
 * Where it doesn't scroll, nothing changes.
 */
export function ScrollEdges({ className, children }: { className?: string; children: ReactNode }) {
  const area = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState<Edges>({ start: false, end: false });

  const measure = () => {
    const row = area.current?.firstElementChild;
    if (!(row instanceof HTMLElement)) return;
    const next = scrollEdges(row);
    setEdges((shown) => (shown.start === next.start && shown.end === next.end ? shown : next));
  };
  // After every render, since a tab can come or go, or change its words.
  useLayoutEffect(measure);
  useEffect(() => {
    const row = area.current?.firstElementChild;
    if (!(row instanceof HTMLElement)) return;
    row.addEventListener("scroll", measure, { passive: true });
    const observer = new ResizeObserver(measure);
    observer.observe(row);
    return () => {
      row.removeEventListener("scroll", measure);
      observer.disconnect();
    };
  }, []);

  const mask = fadeMask(edges);
  return (
    <div className={cn("relative min-w-0", className)} data-scrolls={edges.start || edges.end ? [edges.start && "start", edges.end && "end"].filter(Boolean).join(" ") : undefined}>
      <div ref={area} style={mask ? ({ maskImage: mask, WebkitMaskImage: mask } as CSSProperties) : undefined}>
        {children}
      </div>
      {edges.start && (
        <ChevronLeft size={14} aria-hidden="true" className="pointer-events-none absolute top-1/2 left-0.5 -translate-y-1/2 text-muted" />
      )}
      {edges.end && (
        <ChevronRight size={14} aria-hidden="true" className="pointer-events-none absolute top-1/2 right-0.5 -translate-y-1/2 text-muted" />
      )}
    </div>
  );
}
