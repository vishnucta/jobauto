import "server-only";

import { prisma } from "@/lib/prisma";

import { companyKey, parseConnections, sameCompany, type Person } from "./network";

/** At most this many connections are kept: LinkedIn's limit is 30,000. */
const MAX_CONNECTIONS = 30_000;

export class NetworkError extends Error {}

/** Replaces her connections with those in a new Connections.csv; how many were kept. */
export async function importConnections(text: string): Promise<number> {
  const rows = parseConnections(text);
  if (!rows) throw new NetworkError("That isn't LinkedIn's Connections.csv: its rows start with First Name, Last Name, URL. Look for it in the export's folder.");
  const kept = rows.slice(0, MAX_CONNECTIONS);
  await prisma.$transaction(async (tx) => {
    await tx.connection.deleteMany();
    for (let index = 0; index < kept.length; index += 500) await tx.connection.createMany({ data: kept.slice(index, index + 500) });
  }, { timeout: 60_000, maxWait: 10_000 });
  return kept.length;
}

export async function networkSummary(): Promise<{ people: number; importedAt: string | null }> {
  const [people, first] = await Promise.all([prisma.connection.count(), prisma.connection.findFirst({ orderBy: { createdAt: "desc" }, select: { createdAt: true } })]);
  return { people, importedAt: first?.createdAt.toISOString() ?? null };
}

export async function forgetConnections(): Promise<void> {
  await prisma.connection.deleteMany();
}

/**
 * The people she knows at each of `companies`, by the company's name as
 * given. Companies she knows nobody at are left out.
 */
export async function peopleAt(companies: readonly string[]): Promise<Record<string, Person[]>> {
  const wanted = [...new Set(companies.map((company) => company.trim()).filter(Boolean))].map((company) => ({ company, key: companyKey(company) })).filter((entry) => entry.key);
  if (wanted.length === 0 || (await prisma.connection.count()) === 0) return {};
  const keys = await prisma.connection.findMany({ distinct: ["companyKey"], select: { companyKey: true } });
  const matching = keys.map((row) => row.companyKey).filter((stored) => wanted.some(({ key }) => sameCompany(key, stored)));
  if (matching.length === 0) return {};
  const all = await prisma.connection.findMany({ where: { companyKey: { in: matching } }, select: { id: true, firstName: true, lastName: true, company: true, position: true, url: true, companyKey: true } });
  const result: Record<string, Person[]> = {};
  for (const { company, key } of wanted) {
    const people = all
      .filter((connection) => sameCompany(key, connection.companyKey))
      .map((connection) => ({ id: connection.id, name: `${connection.firstName} ${connection.lastName}`.trim(), position: connection.position, company: connection.company, url: connection.url }));
    if (people.length > 0) result[company] = people;
  }
  return result;
}
