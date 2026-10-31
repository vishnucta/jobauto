import "server-only";

import type { Prisma } from "@/generated/prisma/client";
import type { LanguageLevel } from "@/generated/prisma/enums";
import { ActionError } from "@/lib/action";
import { PHOTO_KEY, PHOTO_ON_RESUMES_KEY } from "@/lib/photo";
import { prisma } from "@/lib/prisma";
import {
  fieldsFromBasics,
  inEntryOrder,
  type Basics,
  type EducationItem,
  type ExperienceItem,
  type ProjectItem,
  type PublicationItem,
  type ReferenceItem,
} from "@/lib/profile";
import { loadProfileName } from "@/lib/profile-data";
import { firstSort, nextSort } from "@/lib/profile-entries";
import { loadSettings, saveSettings } from "@/lib/settings-data";

// What the profile's changes do. The profile's Server Actions
// (src/app/(app)/profile/actions.ts) check the session and the form's input,
// then call these; the Claude connector's tools
// (src/lib/connector/tools/profile.ts) call them too.

/** Saves the Basics (PRO-1, PRO-2): one row per filled-in field, and a cleared one's row removed. Answers with whether the name changed. */
export async function saveBasicsFields(basics: Basics): Promise<{ nameChanged: boolean }> {
  const before = await loadProfileName();
  await prisma.$transaction(
    Object.entries(fieldsFromBasics(basics)).map(([key, value]) =>
      value === null
        ? prisma.profileField.deleteMany({ where: { key } })
        : prisma.profileField.upsert({ where: { key }, create: { key, value }, update: { value } }),
    ),
  );
  return { nameChanged: before !== basics.name };
}

// ─── Photo (#224) ────────────────────────────────────────────────────────────

/** "Show on resumes" is on unless its row says "false". */
export const photoOnResumesRow = (onResumes: boolean) =>
  onResumes
    ? prisma.profileField.deleteMany({ where: { key: PHOTO_ON_RESUMES_KEY } })
    : prisma.profileField.upsert({
        where: { key: PHOTO_ON_RESUMES_KEY },
        create: { key: PHOTO_ON_RESUMES_KEY, value: "false" },
        update: { value: "false" },
      });

/** Saves the cropped photo, or puts a removed one back as it was (Undo). */
export async function storePhoto(src: string, onResumes: boolean): Promise<void> {
  await prisma.$transaction([
    prisma.profileField.upsert({ where: { key: PHOTO_KEY }, create: { key: PHOTO_KEY, value: src }, update: { value: src } }),
    photoOnResumesRow(onResumes),
  ]);
}

/** Removes the photo, with its "Show on resumes". */
export async function deletePhoto(): Promise<void> {
  await prisma.profileField.deleteMany({ where: { key: { in: [PHOTO_KEY, PHOTO_ON_RESUMES_KEY] } } });
}

// ─── Languages (PRO-4) ───────────────────────────────────────────────────────

/** Adds a language with its level. Adding one that exists, in any case, updates its level instead of adding a duplicate. */
export async function addOrUpdateLanguage(name: string, level: LanguageLevel) {
  const existing = await prisma.language.findUnique({ where: { name } });
  const language = existing
    ? await prisma.language.update({ where: { id: existing.id }, data: { level } })
    : await prisma.language.create({ data: { name, level, sort: await nextSort(prisma.language) } });
  return { language: { id: language.id, name: language.name, level: language.level }, added: !existing };
}

// ─── Entries (PRO-5 to PRO-8, PRO-13, #218) ──────────────────────────────────
// "+ Add…" makes a new entry, blank unless `data` fills it in; Undo puts a
// removed one back from what was kept of it.

/** "+ Add a role": last in date order (a blank one has no dates yet), first in an order set by hand. */
export async function newExperience(data: Omit<Prisma.ExperienceCreateInput, "sort"> = {}) {
  const manual = (await loadSettings()).experienceOrder === "manual";
  const sort = manual ? await firstSort(prisma.experience) : await nextSort(prisma.experience);
  return prisma.experience.create({ data: { ...data, sort } });
}

/** Puts a removed role back, with the links to skills that still exist; answers with it and those skills' ids. */
export async function restoreExperienceEntry({ skillIds, ...entry }: ExperienceItem) {
  const skills = await prisma.skill.findMany({ where: { id: { in: skillIds } }, select: { id: true } });
  const restored = await prisma.experience.upsert({
    where: { id: entry.id },
    create: {
      ...entry,
      sort: await nextSort(prisma.experience),
      skills: { create: skills.map((skill) => ({ skillId: skill.id })) },
    },
    update: {},
  });
  return { restored, skillIds: skills.map((skill) => skill.id) };
}

/** "+ Add a project": placed like a new role. */
export async function newProject(data: Omit<Prisma.ProjectCreateInput, "sort"> = {}) {
  const manual = (await loadSettings()).projectOrder === "manual";
  const sort = manual ? await firstSort(prisma.project) : await nextSort(prisma.project);
  return prisma.project.create({ data: { ...data, sort } });
}

/** Puts a removed project back, with the links to skills that still exist; answers with it and those skills' ids. */
export async function restoreProjectEntry({ skillIds, ...entry }: ProjectItem) {
  const skills = await prisma.skill.findMany({ where: { id: { in: skillIds } }, select: { id: true } });
  const restored = await prisma.project.upsert({
    where: { id: entry.id },
    create: {
      ...entry,
      sort: await nextSort(prisma.project),
      skills: { create: skills.map((skill) => ({ skillId: skill.id })) },
    },
    update: {},
  });
  return { restored, skillIds: skills.map((skill) => skill.id) };
}

/** "+ Add education": placed like a new role. */
export async function newEducation(data: Omit<Prisma.EducationCreateInput, "sort"> = {}) {
  const manual = (await loadSettings()).educationOrder === "manual";
  const sort = manual ? await firstSort(prisma.education) : await nextSort(prisma.education);
  return prisma.education.create({ data: { ...data, sort } });
}

export async function restoreEducationEntry(entry: EducationItem) {
  return prisma.education.upsert({
    where: { id: entry.id },
    create: { ...entry, sort: await nextSort(prisma.education) },
    update: {},
  });
}

/** "+ Add a publication": at the top, where the newest usually goes. */
export async function newPublication(data: Omit<Prisma.PublicationCreateInput, "sort"> = {}) {
  return prisma.publication.create({ data: { ...data, sort: await firstSort(prisma.publication) } });
}

/** Puts a removed publication back, last; the list then saves its place in the order. */
export async function restorePublicationEntry(entry: PublicationItem) {
  return prisma.publication.upsert({
    where: { id: entry.id },
    create: { ...entry, sort: await nextSort(prisma.publication) },
    update: {},
  });
}

export async function newReference(data: Omit<Prisma.ReferenceCreateInput, "sort"> = {}) {
  return prisma.reference.create({ data: { ...data, sort: await nextSort(prisma.reference) } });
}

export async function restoreReferenceEntry(entry: ReferenceItem) {
  return prisma.reference.upsert({
    where: { id: entry.id },
    create: { ...entry, sort: await nextSort(prisma.reference) },
    update: {},
  });
}

// ─── Order (E4-9) ────────────────────────────────────────────────────────────

/** The sections ordered by date until an entry is moved by hand. */
export type OrderedSection = "experience" | "project" | "education";

/** Each ordered section's setting. */
export const ORDER_SETTING = { experience: "experienceOrder", project: "projectOrder", education: "educationOrder" } as const;

/** The section's table, as far as ordering needs it. */
function entries(db: Prisma.TransactionClient, section: OrderedSection) {
  const select = { id: true, sort: true, startYear: true, startMonth: true, endYear: true, endMonth: true, current: true } as const;
  const setSort = (entryId: string, sort: number) => ({ where: { id: entryId }, data: { sort } });
  if (section === "experience") {
    return { list: () => db.experience.findMany({ select }), setSort: (entryId: string, sort: number) => db.experience.update(setSort(entryId, sort)) };
  }
  if (section === "project") {
    return { list: () => db.project.findMany({ select }), setSort: (entryId: string, sort: number) => db.project.update(setSort(entryId, sort)) };
  }
  return { list: () => db.education.findMany({ select }), setSort: (entryId: string, sort: number) => db.education.update(setSort(entryId, sort)) };
}

/** Whether `ids` is every one of the `known` ids, each once. */
const isWholeList = (ids: string[], known: Set<string>) =>
  ids.length === known.size && new Set(ids).size === ids.length && ids.every((entryId) => known.has(entryId));

/**
 * Saves an order set by hand: `ids` is every entry of the section, in the new
 * order. From then on the section keeps that order instead of dates.
 */
export async function reorderSection(section: OrderedSection, ids: string[]): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const table = entries(tx, section);
    const known = new Set((await table.list()).map((entry) => entry.id));
    if (!isWholeList(ids, known)) throw new ActionError("The list changed in the meantime. Reload the page and try again.");
    for (const [sort, entryId] of ids.entries()) await table.setSort(entryId, sort);
    await saveSettings({ [ORDER_SETTING[section]]: "manual" }, tx);
  });
}

/** Goes back to date order; answers with the section's ids in that order. */
export async function sortSectionByDate(section: OrderedSection): Promise<string[]> {
  await saveSettings({ [ORDER_SETTING[section]]: "date" });
  return inEntryOrder(await entries(prisma, section).list(), "date").map((entry) => entry.id);
}

/** Saves the publications' order (#218): `ids` is every publication, in the new order. */
export async function reorderPublicationList(ids: string[]): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const known = new Set((await tx.publication.findMany({ select: { id: true } })).map((entry) => entry.id));
    if (!isWholeList(ids, known)) throw new ActionError("The list changed in the meantime. Reload the page and try again.");
    for (const [sort, entryId] of ids.entries()) await tx.publication.update({ where: { id: entryId }, data: { sort } });
  });
}
