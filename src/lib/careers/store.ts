import "server-only";

import type { Employer } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";

import { boardFor, nameFromBoard } from "./boards";
import { employerFields, type EmployerFields, type EmployerView } from "./store-types";

export { employerFields, type EmployerFields, type EmployerView };

// The employers whose careers pages Find jobs follows (jobauto fork).

export const employerView = (employer: Employer): EmployerView => ({
  id: employer.id,
  name: employer.name,
  careersUrl: employer.careersUrl,
  ats: employer.ats,
  keywords: employer.keywords,
  places: employer.places,
  enabled: employer.enabled,
  notes: employer.notes,
  lastCheckedAt: employer.lastCheckedAt?.toISOString() ?? null,
  lastMatched: employer.lastMatched,
  lastNew: employer.lastNew,
  problem: employer.problem,
});

export async function listEmployers(): Promise<EmployerView[]> {
  return (await prisma.employer.findMany({ orderBy: [{ name: "asc" }, { createdAt: "asc" }] })).map(employerView);
}

/** Fields as stored: the job system read from the address, and a name from it when none is given. */
function stored(input: EmployerFields) {
  const fields = employerFields.parse(input);
  const board = boardFor(fields.careersUrl)!;
  return { ...fields, name: fields.name || nameFromBoard(board), ats: board.kind };
}

export async function createEmployer(input: EmployerFields): Promise<EmployerView> {
  return employerView(await prisma.employer.create({ data: stored(input) }));
}

/** Saves an employer's fields; a new address is checked afresh. Null when it's gone. */
export async function updateEmployer(id: string, input: EmployerFields): Promise<EmployerView | null> {
  const before = await prisma.employer.findUnique({ where: { id } });
  if (!before) return null;
  const data = stored(input);
  const moved = data.careersUrl !== before.careersUrl;
  return employerView(await prisma.employer.update({ where: { id }, data: { ...data, ...(moved ? { problem: null, lastCheckedAt: null, lastMatched: 0, lastNew: 0 } : {}) } }));
}

export async function setEmployerEnabled(id: string, enabled: boolean): Promise<EmployerView | null> {
  const { count } = await prisma.employer.updateMany({ where: { id }, data: { enabled } });
  return count ? employerView(await prisma.employer.findUniqueOrThrow({ where: { id } })) : null;
}

/** Stops following it. The jobs found on its page stay in Find jobs. */
export async function removeEmployer(id: string): Promise<boolean> {
  const { count } = await prisma.employer.deleteMany({ where: { id } });
  return count > 0;
}
