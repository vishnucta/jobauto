import "server-only";

import { ActionError } from "@/lib/action";
import { prisma } from "@/lib/prisma";

// An application's offer (E30-7): what it pays, when it starts, the
// holidays and the office, and the day to decide by. Typed in on the
// application's page or given through the Claude connector (jobauto fork).

export type OfferFields = {
  /** As they wrote it, e.g. "€82,000 a year". */
  salary: string;
  /** Calendar days, "2026-12-01", or null. */
  decideBy: string | null;
  startDate: string | null;
  holidays: string;
  office: string;
};

/** A calendar day as the Offer table keeps it. */
const day = (value: string | null) => (value ? new Date(`${value}T00:00:00Z`) : null);

/** Saves the offer's details, making the offer when there's none yet. */
export async function saveOfferDetails(applicationId: string, { salary, decideBy, startDate, holidays, office }: OfferFields): Promise<void> {
  if (!(await prisma.application.count({ where: { id: applicationId } }))) throw new ActionError("That application no longer exists.");
  const data = { salary, holidays, office, decideBy: day(decideBy), startDate: day(startDate) };
  await prisma.offer.upsert({ where: { applicationId }, create: { applicationId, ...data }, update: data });
}
