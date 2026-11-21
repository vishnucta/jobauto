import "server-only";

import type { Prisma } from "@/generated/prisma/client";
import type { LanguageLevel } from "@/generated/prisma/enums";
import { ActionError } from "@/lib/action";
import { PHOTO_KEY, PHOTO_ON_RESUMES_KEY } from "@/lib/photo";
import { prisma } from "@/lib/prisma";
import {
  fieldsFromBasics,
  inEntryOrder,
  LEGACY_ADDRESS_KEY,
  type Basics,
  type CertificationItem,
  type CustomItem,
  type EducationItem,
  type ExperienceItem,
  type ProjectItem,
  type PublicationItem,
  type ReferenceItem,
} from "@/lib/profile";
import { loadProfileName } from "@/lib/profile-data";
import { firstSort, nextSort } from "@/lib/profile-entries";
import { loadProfileSettings, saveProfileSettings } from "@/lib/profiles";

// What the profile's changes do. The profile's Server Actions
// (src/app/(app)/profile/actions.ts) check the session and the form's input,
// then call these; the Claude connector's tools
// (src/lib/connector/tools/profile.ts) call them too. Since there are several
// profiles (E24-1), a change that adds to a list, orders it or touches a
// profile's own headline, summary or settings takes that profile's id; the
// rest of the basics, the photo and the languages are every profile's.

/**
 * Saves the Basics (PRO-1, PRO-2): one row per filled-in shared field, and a
 * cleared one's row removed; the headline and summary go on the profile
 * (E24-1). Answers with whether the name changed.
 */
export async function saveBasicsFields(profileId: string, basics: Basics): Promise<{ nameChanged: boolean }> {
  const before = await loadProfileName();
  await prisma.$transaction([
    ...Object.entries(fieldsFromBasics(basics)).map(([key, value]) =>
      value === null
        ? prisma.profileField.deleteMany({ where: { key } })
        : prisma.profileField.upsert({ where: { key }, create: { key, value }, update: { value } }),
    ),
    // The old one-line address, now held by the four address fields.
    prisma.profileField.deleteMany({ where: { key: LEGACY_ADDRESS_KEY } }),
    // The headline and summary are the profile's own (E24-1).
    prisma.profile.updateMany({ where: { id: profileId }, data: { headline: basics.headline, summary: basics.summary } }),
  ]);
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

/** Adds a language with its level, for every profile. Adding one that exists, in any case, updates its level instead of adding a duplicate. */
export async function addOrUpdateLanguage(name: string, level: LanguageLevel) {
  const existing = await prisma.language.findUnique({ where: { name } });
  const language = existing
    ? await prisma.language.update({ where: { id: existing.id }, data: { level } })
    : await prisma.language.create({ data: { name, level, sort: await nextSort(prisma.language) } });
  return { language: { id: language.id, name: language.name, level: language.level }, added: !existing };
}

// ─── Entries (PRO-5 to PRO-8, PRO-13, #218) ──────────────────────────────────
// "+ Add…" makes a new entry in a profile, blank unless `data` fills it in;
// Undo puts a removed one back into its profile from what was kept of it.
// Sort values count only that profile's entries (E24-1).

/** "+ Add a role": last in date order (a blank one has no dates yet), first in an order set by hand. */
export async function newExperience(profileId: string, data: Omit<Prisma.ExperienceUncheckedCreateInput, "sort" | "profileId"> = {}) {
  const manual = (await loadProfileSettings(profileId)).experienceOrder === "manual";
  const sort = manual ? await firstSort(prisma.experience, { profileId }) : await nextSort(prisma.experience, { profileId });
  return prisma.experience.create({ data: { ...data, profileId, sort } });
}

/** Puts a removed role back, with the links to the profile's skills that still exist; answers with it and those skills' ids. */
export async function restoreExperienceEntry(profileId: string, { skillIds, ...entry }: ExperienceItem) {
  const skills = await prisma.skill.findMany({ where: { profileId, id: { in: skillIds } }, select: { id: true } });
  const restored = await prisma.experience.upsert({
    where: { id: entry.id },
    create: {
      ...entry,
      profileId,
      sort: await nextSort(prisma.experience, { profileId }),
      skills: { create: skills.map((skill) => ({ skillId: skill.id })) },
    },
    update: {},
  });
  return { restored, skillIds: skills.map((skill) => skill.id) };
}

/** "+ Add a project": placed like a new role. */
export async function newProject(profileId: string, data: Omit<Prisma.ProjectUncheckedCreateInput, "sort" | "profileId"> = {}) {
  const manual = (await loadProfileSettings(profileId)).projectOrder === "manual";
  const sort = manual ? await firstSort(prisma.project, { profileId }) : await nextSort(prisma.project, { profileId });
  return prisma.project.create({ data: { ...data, profileId, sort } });
}

/** Puts a removed project back, with the links to the profile's skills that still exist; answers with it and those skills' ids. */
export async function restoreProjectEntry(profileId: string, { skillIds, ...entry }: ProjectItem) {
  const skills = await prisma.skill.findMany({ where: { profileId, id: { in: skillIds } }, select: { id: true } });
  const restored = await prisma.project.upsert({
    where: { id: entry.id },
    create: {
      ...entry,
      profileId,
      sort: await nextSort(prisma.project, { profileId }),
      skills: { create: skills.map((skill) => ({ skillId: skill.id })) },
    },
    update: {},
  });
  return { restored, skillIds: skills.map((skill) => skill.id) };
}

/** "+ Add education": placed like a new role. */
export async function newEducation(profileId: string, data: Omit<Prisma.EducationUncheckedCreateInput, "sort" | "profileId"> = {}) {
  const manual = (await loadProfileSettings(profileId)).educationOrder === "manual";
  const sort = manual ? await firstSort(prisma.education, { profileId }) : await nextSort(prisma.education, { profileId });
  return prisma.education.create({ data: { ...data, profileId, sort } });
}

export async function restoreEducationEntry(profileId: string, entry: EducationItem) {
  return prisma.education.upsert({
    where: { id: entry.id },
    create: { ...entry, profileId, sort: await nextSort(prisma.education, { profileId }) },
    update: {},
  });
}

/** "+ Add a publication": at the top, where the newest usually goes. */
export async function newPublication(profileId: string, data: Omit<Prisma.PublicationUncheckedCreateInput, "sort" | "profileId"> = {}) {
  return prisma.publication.create({ data: { ...data, profileId, sort: await firstSort(prisma.publication, { profileId }) } });
}

/** Puts a removed publication back, last; the list then saves its place in the order. */
export async function restorePublicationEntry(profileId: string, entry: PublicationItem) {
  return prisma.publication.upsert({
    where: { id: entry.id },
    create: { ...entry, profileId, sort: await nextSort(prisma.publication, { profileId }) },
    update: {},
  });
}

/** "+ Add a certification" (#293): at the top, where the newest usually goes. */
export async function newCertification(profileId: string, data: Omit<Prisma.CertificationUncheckedCreateInput, "sort" | "profileId"> = {}) {
  return prisma.certification.create({ data: { ...data, profileId, sort: await firstSort(prisma.certification, { profileId }) } });
}

/** Puts a removed certification back, last; the list then saves its place in the order. */
export async function restoreCertificationEntry(profileId: string, entry: CertificationItem) {
  return prisma.certification.upsert({
    where: { id: entry.id },
    create: { ...entry, profileId, sort: await nextSort(prisma.certification, { profileId }) },
    update: {},
  });
}

/** "+ Add an item" in a section the user made (#298): at its end, since nothing in it says what's newest. Null when the section is gone. */
export async function newCustomItem(sectionId: string, data: Omit<Prisma.CustomItemUncheckedCreateInput, "sort" | "sectionId"> = {}) {
  const sort = await nextSort(prisma.customItem, { sectionId });
  if (!(await prisma.customSection.count({ where: { id: sectionId } }))) return null;
  return prisma.customItem.create({ data: { ...data, sectionId, sort } });
}

/** Puts a removed item back, last in its section; null when the section is gone too. */
export async function restoreCustomItemEntry(sectionId: string, entry: CustomItem) {
  if (!(await prisma.customSection.count({ where: { id: sectionId } }))) return null;
  return prisma.customItem.upsert({ where: { id: entry.id }, create: { ...entry, sectionId, sort: await nextSort(prisma.customItem, { sectionId }) }, update: {} });
}

export async function newReference(profileId: string, data: Omit<Prisma.ReferenceUncheckedCreateInput, "sort" | "profileId"> = {}) {
  return prisma.reference.create({ data: { ...data, profileId, sort: await nextSort(prisma.reference, { profileId }) } });
}

export async function restoreReferenceEntry(profileId: string, entry: ReferenceItem) {
  return prisma.reference.upsert({
    where: { id: entry.id },
    create: { ...entry, profileId, sort: await nextSort(prisma.reference, { profileId }) },
    update: {},
  });
}

// ─── Order (E4-9) ────────────────────────────────────────────────────────────

/** The sections ordered by date until an entry is moved by hand. */
export type OrderedSection = "experience" | "project" | "education";

/** Each ordered section's setting, one of the profile's own (E24-1). */
export const ORDER_SETTING = { experience: "experienceOrder", project: "projectOrder", education: "educationOrder" } as const;

/** The section's table in one profile, as far as ordering needs it. */
function entries(db: Prisma.TransactionClient, section: OrderedSection, profileId: string) {
  const select = { id: true, sort: true, startYear: true, startMonth: true, endYear: true, endMonth: true, current: true } as const;
  const where = { profileId };
  const setSort = (entryId: string, sort: number) => ({ where: { id: entryId }, data: { sort } });
  if (section === "experience") {
    return { list: () => db.experience.findMany({ where, select }), setSort: (entryId: string, sort: number) => db.experience.update(setSort(entryId, sort)) };
  }
  if (section === "project") {
    return { list: () => db.project.findMany({ where, select }), setSort: (entryId: string, sort: number) => db.project.update(setSort(entryId, sort)) };
  }
  return { list: () => db.education.findMany({ where, select }), setSort: (entryId: string, sort: number) => db.education.update(setSort(entryId, sort)) };
}

/** Whether `ids` is every one of the `known` ids, each once. */
const isWholeList = (ids: string[], known: Set<string>) =>
  ids.length === known.size && new Set(ids).size === ids.length && ids.every((entryId) => known.has(entryId));

/**
 * Saves an order set by hand: `ids` is every entry of the profile's section,
 * in the new order. From then on the section keeps that order instead of dates.
 */
export async function reorderSection(profileId: string, section: OrderedSection, ids: string[]): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const table = entries(tx, section, profileId);
    const known = new Set((await table.list()).map((entry) => entry.id));
    if (!isWholeList(ids, known)) throw new ActionError("The list changed in the meantime. Reload the page and try again.");
    for (const [sort, entryId] of ids.entries()) await table.setSort(entryId, sort);
    await saveProfileSettings(profileId, { [ORDER_SETTING[section]]: "manual" }, tx);
  });
}

/** Goes back to date order; answers with the profile's section's ids in that order. */
export async function sortSectionByDate(profileId: string, section: OrderedSection): Promise<string[]> {
  await saveProfileSettings(profileId, { [ORDER_SETTING[section]]: "date" });
  return inEntryOrder(await entries(prisma, section, profileId).list(), "date").map((entry) => entry.id);
}

/** Saves the publications' order (#218): `ids` is every publication of the profile, in the new order. */
export async function reorderPublicationList(profileId: string, ids: string[]): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const known = new Set((await tx.publication.findMany({ where: { profileId }, select: { id: true } })).map((entry) => entry.id));
    if (!isWholeList(ids, known)) throw new ActionError("The list changed in the meantime. Reload the page and try again.");
    for (const [sort, entryId] of ids.entries()) await tx.publication.update({ where: { id: entryId }, data: { sort } });
  });
}

/** Saves the certifications' order (#293): `ids` is every certification of the profile, in the new order. */
export async function reorderCertificationList(profileId: string, ids: string[]): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const known = new Set((await tx.certification.findMany({ where: { profileId }, select: { id: true } })).map((entry) => entry.id));
    if (!isWholeList(ids, known)) throw new ActionError("The list changed in the meantime. Reload the page and try again.");
    for (const [sort, entryId] of ids.entries()) await tx.certification.update({ where: { id: entryId }, data: { sort } });
  });
}

/** Saves the order of a section the user made (#298): `ids` is each of its items, in the new order. */
export async function reorderCustomItemList(sectionId: string, ids: string[]): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const known = new Set((await tx.customItem.findMany({ where: { sectionId }, select: { id: true } })).map((entry) => entry.id));
    if (!isWholeList(ids, known)) throw new ActionError("The list changed in the meantime. Reload the page and try again.");
    for (const [sort, entryId] of ids.entries()) await tx.customItem.update({ where: { id: entryId }, data: { sort } });
  });
}
