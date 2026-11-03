import "server-only";

import type { Recruiter, RecruiterEvent } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";

import { logServerError } from "@/lib/log";

import { agencyOf, foldName, FOLLOW_UP_DAYS, sameAgency, SNOOZE_DAYS, STARTER_RECRUITERS, type RecruiterStatusName, type RecruiterView } from "./types";

// The recruiters the user keeps track of. Each change that matters leaves a
// line in the recruiter's history, so "when did I write?" has an answer.

const DAY_MS = 86_400_000;

type Row = Recruiter & { events: RecruiterEvent[] };

function viewOf(row: Row): RecruiterView {
  return {
    id: row.id,
    name: row.name,
    contactName: row.contactName,
    email: row.email,
    website: row.website,
    speciality: row.speciality,
    notes: row.notes,
    source: row.source,
    status: row.status,
    contactedAt: row.contactedAt?.toISOString() ?? null,
    followUpAt: row.followUpAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    events: row.events.map((event) => ({ id: event.id, text: event.text, at: event.at.toISOString() })),
  };
}

const withEvents = { events: { orderBy: { at: "asc" as const } } };

/** Every recruiter, the oldest first; the screen sorts and filters. */
export async function listRecruiters(): Promise<RecruiterView[]> {
  return (await prisma.recruiter.findMany({ orderBy: { createdAt: "asc" }, include: withEvents })).map(viewOf);
}

export type RecruiterFields = {
  name: string;
  contactName: string;
  email: string;
  website: string;
  speciality: string;
  notes: string;
};

const ADDED_TEXT: Record<string, string> = { you: "Added", "starter list": "Added from the starter list" };

export async function createRecruiter(fields: RecruiterFields, source = "you"): Promise<RecruiterView> {
  // Adding one by hand, or from the starter list, lifts "removed": the user wants it now.
  await prisma.recruiterBlock.deleteMany({ where: { key: foldName(fields.name) } });
  const row = await prisma.recruiter.create({ data: { ...fields, source, events: { create: { text: ADDED_TEXT[source] ?? "Added" } } }, include: withEvents });
  return viewOf(row);
}

/** Saves the fields given; null when the recruiter is gone. */
export async function updateRecruiter(id: string, fields: RecruiterFields): Promise<RecruiterView | null> {
  const { count } = await prisma.recruiter.updateMany({ where: { id }, data: fields });
  if (count === 0) return null;
  return viewOf(await prisma.recruiter.findUniqueOrThrow({ where: { id }, include: withEvents }));
}

const EVENT_TEXT: Record<RecruiterStatusName, string> = {
  NOT_CONTACTED: "Back on the list",
  CONTACTED: "Marked as contacted",
  REPLIED: "They replied",
  NOT_INTERESTED: "Marked as not interested",
};

/**
 * Moves the conversation on. Writing to them starts the follow-up clock; a
 * reply or "not interested" stops it. Null when the recruiter is gone.
 */
export async function setRecruiterStatus(id: string, status: RecruiterStatusName, now = new Date()): Promise<RecruiterView | null> {
  const exists = await prisma.recruiter.findUnique({ where: { id }, select: { contactedAt: true } });
  if (!exists) return null;
  const data =
    status === "CONTACTED"
      ? { contactedAt: now, followUpAt: new Date(now.getTime() + FOLLOW_UP_DAYS * DAY_MS) }
      : status === "NOT_CONTACTED"
        ? { contactedAt: null, followUpAt: null }
        : { followUpAt: null };
  const row = await prisma.recruiter.update({
    where: { id },
    data: { status, ...data, events: { create: { text: EVENT_TEXT[status], at: now } } },
    include: withEvents,
  });
  return viewOf(row);
}

/** Waits a few more days before the follow-up is due. Null when the recruiter is gone or isn't being waited on. */
export async function snoozeRecruiter(id: string, now = new Date()): Promise<RecruiterView | null> {
  const found = await prisma.recruiter.findUnique({ where: { id }, select: { status: true } });
  if (found?.status !== "CONTACTED") return null;
  const until = new Date(now.getTime() + SNOOZE_DAYS * DAY_MS);
  const row = await prisma.recruiter.update({
    where: { id },
    data: { followUpAt: until, events: { create: { text: `Snoozed for ${SNOOZE_DAYS} days`, at: now } } },
    include: withEvents,
  });
  return viewOf(row);
}

/** Removes one, and remembers its name so a later search or job doesn't put it back. */
export async function removeRecruiter(id: string): Promise<boolean> {
  const found = await prisma.recruiter.findUnique({ where: { id }, select: { name: true } });
  if (!found) return false;
  const key = foldName(found.name);
  await prisma.$transaction([prisma.recruiterBlock.upsert({ where: { key }, create: { key }, update: {} }), prisma.recruiter.deleteMany({ where: { id } })]);
  return true;
}

const MAX_SEEN_EVENTS = 25;

/**
 * Puts the agencies among `jobs` on the list: one that isn't there yet is
 * added with where it was found, and one that is gets a line in its history
 * for each role it posted, once. An agency the user removed stays off.
 * Never throws: a search or an application must not fail over this. Says how
 * many agencies were new.
 */
export async function noteAgencies(jobs: { company: string; title: string }[], via: "search" | "job"): Promise<number> {
  try {
    const found = new Map<string, { name: string; titles: Set<string> }>();
    for (const job of jobs) {
      const agency = agencyOf(job.company);
      if (!agency) continue;
      const entry = found.get(agency.key) ?? { name: agency.name, titles: new Set<string>() };
      if (job.title.trim()) entry.titles.add(job.title.trim().replace(/\s+/g, " ").slice(0, 180));
      found.set(agency.key, entry);
    }
    if (found.size === 0) return 0;

    const [existing, blocks] = await Promise.all([
      prisma.recruiter.findMany({ select: { id: true, name: true, events: { select: { text: true } } } }),
      prisma.recruiterBlock.findMany({ select: { key: true } }),
    ]);
    const blocked = new Set(blocks.map((block) => block.key));
    let added = 0;
    for (const [key, agency] of found) {
      if (blocked.has(key)) continue;
      const have = existing.find((row) => sameAgency(row.name, agency.name));
      const seen = new Set(have?.events.map((event) => event.text));
      const lines = [...agency.titles].map((title) => `Posted: ${title}`).filter((text) => !seen.has(text));
      if (have) {
        const room = MAX_SEEN_EVENTS - seen.size;
        if (lines.length > 0 && room > 0) {
          await prisma.recruiterEvent.createMany({ data: lines.slice(0, room).map((text) => ({ recruiterId: have.id, text })) });
        }
        continue;
      }
      await prisma.recruiter.create({
        data: {
          name: agency.name,
          source: via === "search" ? "found in search" : "came with a job",
          events: { create: [{ text: via === "search" ? "Found in a search" : "Came with a job" }, ...lines.slice(0, MAX_SEEN_EVENTS).map((text) => ({ text }))] },
        },
      });
      existing.push({ id: "", name: agency.name, events: [] });
      added += 1;
    }
    return added;
  } catch (error) {
    logServerError("recruiters", error);
    return 0;
  }
}

/** Adds the starter agencies the list doesn't have yet, by name; says how many. */
export async function addStarterRecruiters(): Promise<number> {
  const have = new Set((await prisma.recruiter.findMany({ select: { name: true } })).map((row) => row.name.trim().toLowerCase()));
  const missing = STARTER_RECRUITERS.filter((starter) => !have.has(starter.name.toLowerCase()));
  for (const starter of missing) {
    await createRecruiter({ ...starter, contactName: "", email: "" }, "starter list");
  }
  return missing.length;
}
