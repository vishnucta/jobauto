"use client";

import { DndContext } from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import Link from "next/link";
import { useState } from "react";

import { DragHandle, MoveButton, useRowSorting } from "@/components/reorder-controls";
import { cn } from "@/lib/cn";

import { sectionHref, type NavSection, type ProfilePage } from "./sections";

type Row = NavSection & { count: string };

/**
 * The Profile page's sections (#337): a link to each, to drag or move with
 * buttons. The buttons show when the row is hovered or reached with the
 * keyboard, where they take the count's place.
 */
export function SectionNav({ rows, current, onMove }: { rows: Row[]; current: ProfilePage; onMove: (rows: string[]) => void }) {
  const [announcement, setAnnouncement] = useState("");
  const keys = rows.map((row) => row.id as string);
  const { move, context } = useRowSorting({ keys, nameOf: (key) => rows.find((row) => row.id === key)?.label ?? "", onMove, announce: setAnnouncement });

  return (
    <nav aria-label="Profile sections">
      <DndContext {...context}>
        <SortableContext items={keys} strategy={verticalListSortingStrategy}>
          <ul className="flex flex-col gap-0.5">
            {rows.map((row, index) => (
              <SectionRow
                key={row.id}
                row={row}
                selected={row.id === current}
                first={index === 0}
                last={index === rows.length - 1}
                moveUp={() => move(index, index - 1)}
                moveDown={() => move(index, index + 1)}
              />
            ))}
          </ul>
        </SortableContext>
      </DndContext>
      <Link
        href={sectionHref("new")}
        aria-current={current === "new" ? "page" : undefined}
        className={cn("mt-0.5 block rounded-control py-[9px] pr-3 pl-8 text-sm text-muted hover:bg-hover hover:text-ink", current === "new" && "bg-selected font-medium text-ink hover:bg-selected")}
      >
        + Add a section
      </Link>
      <span role="status" className="sr-only">
        {announcement}
      </span>
    </nav>
  );
}

function SectionRow({ row, selected, first, last, moveUp, moveDown }: { row: Row; selected: boolean; first: boolean; last: boolean; moveUp: () => void; moveDown: () => void }) {
  const { setNodeRef, setActivatorNodeRef, listeners, transform, transition, isDragging } = useSortable({ id: row.id });
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn("group flex items-center rounded-control pr-1 hover:bg-hover", selected && "bg-selected hover:bg-selected", isDragging && "relative z-10 bg-card opacity-90 shadow-menu")}
    >
      <DragHandle ref={setActivatorNodeRef} {...listeners} />
      <Link
        href={sectionHref(row.id)}
        aria-current={selected ? "page" : undefined}
        className={cn("flex min-w-0 flex-1 items-center justify-between gap-2 py-[9px] pr-2 pl-1 text-sm text-ink hover:text-ink", selected && "font-medium")}
      >
        <span className="min-w-0 truncate">
          {row.label}
          {row.optional && <span className="ml-2 text-xs font-normal text-muted">optional</span>}
        </span>{" "}
        <span className="text-xs font-normal text-muted tabular-nums group-hover:hidden group-has-focus-visible:hidden">{row.count}</span>
      </Link>
      <span className="hidden flex-none gap-0.5 group-hover:flex group-has-focus-visible:flex">
        <MoveButton label={`Move “${row.label}” up`} disabled={first} onClick={moveUp}>
          ↑
        </MoveButton>
        <MoveButton label={`Move “${row.label}” down`} disabled={last} onClick={moveDown}>
          ↓
        </MoveButton>
      </span>
    </li>
  );
}
