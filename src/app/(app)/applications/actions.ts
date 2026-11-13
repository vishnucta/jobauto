"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { ApplicationStatus } from "@/generated/prisma/enums";
import { action } from "@/lib/action";
import { FILTERS, SORT_KEYS, VIEWS } from "@/lib/applications-list";
import { boardOrder, withShownOrder } from "@/lib/board-order";
import { prisma } from "@/lib/prisma";
import { saveSettings } from "@/lib/settings-data";

/** Remembers how the Applications screen was left (LST-7), for the next visit. */
export const rememberListView = action(
  z.object({
    view: z.enum(VIEWS),
    filter: z.enum(FILTERS.map((filter) => filter.value)),
    sort: z.object({ key: z.enum(SORT_KEYS), reversed: z.boolean() }),
  }),
  async ({ view, filter, sort }) => {
    await saveSettings({
      applicationsView: view,
      applicationsFilter: filter,
      applicationsSort: `${sort.reversed ? "-" : ""}${sort.key}`,
    });
    return null;
  },
);

/**
 * Writes a board column's new order (public issue 60). `ids` are the cards on
 * screen; the whole column gets a place, so what a search or the archive
 * hides stays where it is. Reordering isn't news, so "Updated" stays as it was.
 */
export const reorderBoard = action(
  z.object({
    status: z.enum(ApplicationStatus),
    ids: z.array(z.string().min(1)).min(1),
  }),
  async ({ status, ids }) => {
    const column = await prisma.application.findMany({
      where: { status, awaitingReview: false },
      select: { id: true, boardSort: true, updatedAt: true },
    });
    await prisma.$transaction(
      withShownOrder(column.sort(boardOrder), ids).map(({ id, updatedAt }, boardSort) =>
        prisma.application.updateMany({ where: { id, status }, data: { boardSort, updatedAt } }),
      ),
    );
    revalidatePath("/applications");
    return null;
  },
);
