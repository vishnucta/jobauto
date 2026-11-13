"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { CustomSectionFormat, LanguageLevel } from "@/generated/prisma/enums";
import { action, ActionError } from "@/lib/action";
import { rewriteSectionOnDrafts } from "@/lib/custom-section-drafts";
import { prisma } from "@/lib/prisma";
import { findOrCreateSkill, firstSort, nextSort } from "@/lib/profile-entries";
import { applyProfileImportJob, discardProfileImports } from "@/lib/jobs/import-profile";
import { isPhotoDataUrl, PHOTO_MAX_LENGTH } from "@/lib/photo";
import {
  addOrUpdateLanguage,
  deletePhoto,
  newEducation,
  newExperience,
  newProject,
  newPublication,
  newReference,
  photoOnResumesRow,
  reorderPublicationList,
  reorderSection,
  restoreEducationEntry,
  restoreExperienceEntry,
  restoreProjectEntry,
  restorePublicationEntry,
  restoreReferenceEntry,
  saveBasicsFields,
  sortSectionByDate,
  storePhoto,
} from "@/lib/profile-edits";
import { importCounts } from "@/lib/profile-import";
import { saveSettings } from "@/lib/settings-data";

// Every profile change saves through these actions; they all check the
// session (action()) and validate their input. What a change does is in
// src/lib/profile-edits.ts, which the Claude connector uses too.

const text = (max: number) => z.string().max(max);

/** Saves the Basics section (PRO-1, PRO-2); autosaved as you type. */
export const saveBasics = action(
  z.object({
    name: text(200),
    headline: text(300),
    email: text(320),
    phone: text(60),
    dob: z.union([z.literal(""), z.iso.date()]),
    website: text(500),
    address: text(300),
    city: text(120),
    country: text(120),
    linkedin: text(500),
    summary: text(5000),
    showAge: z.boolean(),
  }),
  async (basics) => {
    const { nameChanged } = await saveBasicsFields(basics);
    // The sidebar shows the name.
    if (nameChanged) revalidatePath("/", "layout");
    return null;
  },
);

// ─── Photo (#224) ────────────────────────────────────────────────────────────

/** Saves the cropped photo, or puts a removed one back as it was (Undo). */
export const savePhoto = action(
  z.object({ src: z.string().max(PHOTO_MAX_LENGTH).refine(isPhotoDataUrl), onResumes: z.boolean() }),
  async ({ src, onResumes }) => {
    await storePhoto(src, onResumes);
    return null;
  },
);

/** The photo's "Show on resumes". */
export const setPhotoOnResumes = action(z.object({ onResumes: z.boolean() }), async ({ onResumes }) => {
  await photoOnResumesRow(onResumes);
  return null;
});

export const removePhoto = action(z.object({}), async () => {
  await deletePhoto();
  return null;
});

const id = z.string().min(1);
const skillName = z.string().trim().min(1, "Type a skill first.").max(100);

/** Adds a skill (PRO-3). An existing one, in any case, is returned instead of a duplicate. */
/** A skill group's name (#280): it leads a line on resumes ("Tools: Figma · Ahrefs"), so no ":" or "·". */
const skillGroup = z
  .string()
  .trim()
  .max(60, "Keep a group's name under 60 characters.")
  .refine((name) => !/[:·\n]/.test(name), "A group's name can't have “:” or “·” in it.");

/** Adds a skill, in a group or none; one that's there already moves to that group (#280). */
export const addSkill = action(z.object({ name: skillName, group: skillGroup.default("") }), ({ name, group }) => findOrCreateSkill(name, group));

/** Moves a skill into a group, or out of any (#280). */
export const setSkillGroup = action(z.object({ id, group: skillGroup }), async ({ id, group }) => {
  await prisma.skill.updateMany({ where: { id }, data: { group } });
  return null;
});

/** Renames a group: its skills move with it, into another group of that name if there is one (#280). */
export const renameSkillGroup = action(
  z.object({ from: skillGroup.pipe(z.string().min(1)), to: skillGroup.pipe(z.string().min(1, "Give the group a name.")) }),
  async ({ from, to }) => {
    await prisma.skill.updateMany({ where: { group: from }, data: { group: to } });
    return null;
  },
);

/** Removes a skill; the database also detaches it from every role (PRO-3). */
/** A skill dragged or moved in Profile → Skills (public issue 62): every skill's id in the new order. From then on tailored resumes keep it. */
export const reorderSkills = action(z.object({ ids: z.array(id) }), async ({ ids }) => {
  await prisma.$transaction(async (tx) => {
    const known = new Set((await tx.skill.findMany({ select: { id: true } })).map((entry) => entry.id));
    if (ids.length !== known.size || new Set(ids).size !== ids.length || !ids.every((entryId) => known.has(entryId))) {
      throw new ActionError("The list changed in the meantime. Reload the page and try again.");
    }
    for (const [sort, entryId] of ids.entries()) await tx.skill.update({ where: { id: entryId }, data: { sort } });
    await saveSettings({ skillOrder: "manual" }, tx);
  });
  return null;
});

/** Back to the most relevant first on tailored resumes; the order in Profile → Skills stays. */
export const setSkillOrder = action(z.object({ order: z.enum(["relevance", "manual"]) }), async ({ order }) => {
  await saveSettings({ skillOrder: order });
  return null;
});

export const removeSkill = action(z.object({ id }), async ({ id }) => {
  await prisma.skill.deleteMany({ where: { id } });
  return null;
});

const level = z.enum(LanguageLevel);

/**
 * Adds a language with its level (PRO-4). Adding one that exists, in any
 * case, updates its level instead of adding a duplicate.
 */
export const addLanguage = action(
  z.object({ name: z.string().trim().min(1, "Type a language first.").max(100), level }),
  ({ name, level }) => addOrUpdateLanguage(name, level),
);

export const setLanguageLevel = action(z.object({ id, level }), async ({ id, level }) => {
  await prisma.language.updateMany({ where: { id }, data: { level } });
  return null;
});

export const removeLanguage = action(z.object({ id }), async ({ id }) => {
  await prisma.language.deleteMany({ where: { id } });
  return null;
});

// ─── Experience (PRO-5, PRO-6) ───────────────────────────────────────────────

const year = z.number().int().min(1900).max(2100).nullable();
const month = z.number().int().min(1).max(12).nullable();
const dateSpan = { startYear: year, startMonth: month, endYear: year, endMonth: month, current: z.boolean() };

const experienceFields = z.object({
  id,
  role: text(200),
  company: text(200),
  location: text(200),
  descriptor: text(300),
  bullets: text(10_000),
  ...dateSpan,
});

const experienceItem = (entry: {
  id: string;
  role: string;
  company: string;
  location: string;
  descriptor: string;
  volunteering: boolean;
  bullets: string;
  startYear: number | null;
  startMonth: number | null;
  endYear: number | null;
  endMonth: number | null;
  current: boolean;
}, skillIds: string[] = []) => ({
  id: entry.id,
  role: entry.role,
  company: entry.company,
  location: entry.location,
  descriptor: entry.descriptor,
  volunteering: entry.volunteering,
  bullets: entry.bullets,
  startYear: entry.startYear,
  startMonth: entry.startMonth,
  endYear: entry.endYear,
  endMonth: entry.endMonth,
  current: entry.current,
  skillIds,
});

/** "+ Add a role": a blank entry, last in date order (it has no dates yet), first in an order set by hand. */
export const createExperience = action(z.object({ volunteering: z.boolean().default(false) }), async ({ volunteering }) =>
  experienceItem(await newExperience({ volunteering })),
);

/** Autosaves a role. Saving one that was just removed does nothing. */
export const saveExperience = action(experienceFields, async ({ id, ...data }) => {
  await prisma.experience.updateMany({ where: { id }, data });
  return null;
});

/** Moves a role between Experience and Volunteering. On its own, so an autosave on its way can't move it back. */
export const setRoleVolunteering = action(z.object({ id, volunteering: z.boolean() }), async ({ id: roleId, volunteering }) => {
  await prisma.experience.updateMany({ where: { id: roleId }, data: { volunteering } });
  return null;
});

/** Removes a role and its skill links; the toast's Undo calls restoreExperience. */
export const removeExperience = action(z.object({ id }), async ({ id }) => {
  await prisma.experience.deleteMany({ where: { id } });
  return null;
});

/** Puts a removed role back, with the links to skills that still exist. */
export const restoreExperience = action(experienceFields.extend({ volunteering: z.boolean(), skillIds: z.array(id) }), async (entry) => {
  const { restored, skillIds } = await restoreExperienceEntry(entry);
  return experienceItem(restored, skillIds);
});

/** Attaches a skill to a role, or detaches it (PRO-6). */
export const setExperienceSkill = action(
  z.object({ experienceId: id, skillId: id, attached: z.boolean() }),
  async ({ experienceId, skillId, attached }) => {
    if (attached) {
      await prisma.experienceSkill.upsert({ where: { experienceId_skillId: { experienceId, skillId } }, create: { experienceId, skillId }, update: {} });
    } else {
      await prisma.experienceSkill.deleteMany({ where: { experienceId, skillId } });
    }
    return null;
  },
);

/** "New skill? Type it and press Enter": adds it to the profile if it's new and attaches it (PRO-6). */
export const attachNewSkill = action(
  z.object({ experienceId: id, name: skillName }),
  async ({ experienceId, name }) => {
    const result = await findOrCreateSkill(name);
    const skillId = result.skill.id;
    await prisma.experienceSkill.upsert({ where: { experienceId_skillId: { experienceId, skillId } }, create: { experienceId, skillId }, update: {} });
    return result;
  },
);

// ─── Projects (PRO-13) ───────────────────────────────────────────────────────

const projectFields = z.object({
  id,
  name: text(200),
  link: text(500),
  bullets: text(10_000),
  ...dateSpan,
});

const projectItem = (entry: z.infer<typeof projectFields>, skillIds: string[] = []) => ({
  id: entry.id,
  name: entry.name,
  link: entry.link,
  bullets: entry.bullets,
  startYear: entry.startYear,
  startMonth: entry.startMonth,
  endYear: entry.endYear,
  endMonth: entry.endMonth,
  current: entry.current,
  skillIds,
});

/** "+ Add a project": a blank entry, placed like a new role. */
export const createProject = action(z.object({}), async () => projectItem(await newProject()));

/** Autosaves a project. Saving one that was just removed does nothing. */
export const saveProject = action(projectFields, async ({ id, ...data }) => {
  await prisma.project.updateMany({ where: { id }, data });
  return null;
});

/** Removes a project and its skill links; the toast's Undo calls restoreProject. */
export const removeProject = action(z.object({ id }), async ({ id }) => {
  await prisma.project.deleteMany({ where: { id } });
  return null;
});

/** Puts a removed project back, with the links to skills that still exist. */
export const restoreProject = action(projectFields.extend({ skillIds: z.array(id) }), async (entry) => {
  const { restored, skillIds } = await restoreProjectEntry(entry);
  return projectItem(restored, skillIds);
});

/** Attaches a skill to a project, or detaches it. */
export const setProjectSkill = action(
  z.object({ projectId: id, skillId: id, attached: z.boolean() }),
  async ({ projectId, skillId, attached }) => {
    if (attached) {
      await prisma.projectSkill.upsert({ where: { projectId_skillId: { projectId, skillId } }, create: { projectId, skillId }, update: {} });
    } else {
      await prisma.projectSkill.deleteMany({ where: { projectId, skillId } });
    }
    return null;
  },
);

/** "New skill? Type it and press Enter" on a project: adds it to the profile if it's new and attaches it. */
export const attachNewProjectSkill = action(z.object({ projectId: id, name: skillName }), async ({ projectId, name }) => {
  const result = await findOrCreateSkill(name);
  const skillId = result.skill.id;
  await prisma.projectSkill.upsert({ where: { projectId_skillId: { projectId, skillId } }, create: { projectId, skillId }, update: {} });
  return result;
});

// ─── Education (PRO-7) ───────────────────────────────────────────────────────

const educationFields = z.object({
  id,
  degree: text(200),
  school: text(200),
  notes: text(5000),
  ...dateSpan,
});

const educationItem = (entry: z.infer<typeof educationFields>) => ({
  id: entry.id,
  degree: entry.degree,
  school: entry.school,
  notes: entry.notes,
  startYear: entry.startYear,
  startMonth: entry.startMonth,
  endYear: entry.endYear,
  endMonth: entry.endMonth,
  current: entry.current,
});

export const createEducation = action(z.object({}), async () => educationItem(await newEducation()));

export const saveEducation = action(educationFields, async ({ id, ...data }) => {
  await prisma.education.updateMany({ where: { id }, data });
  return null;
});

export const removeEducation = action(z.object({ id }), async ({ id }) => {
  await prisma.education.deleteMany({ where: { id } });
  return null;
});

export const restoreEducation = action(educationFields, async (entry) => educationItem(await restoreEducationEntry(entry)));

// ─── Certifications (#293) ───────────────────────────────────────────────────

const certificationFields = z.object({
  id,
  name: text(300),
  issuer: text(200),
  year,
  month,
  expiryYear: year,
  expiryMonth: month,
  credentialId: text(200),
  link: text(500),
  onResumes: z.boolean(),
});

const certificationItem = (entry: z.infer<typeof certificationFields>) => ({
  id: entry.id,
  name: entry.name,
  issuer: entry.issuer,
  year: entry.year,
  month: entry.month,
  expiryYear: entry.expiryYear,
  expiryMonth: entry.expiryMonth,
  credentialId: entry.credentialId,
  link: entry.link,
  onResumes: entry.onResumes,
});

/** "+ Add a certification": a blank entry at the top, where the newest usually goes. */
export const createCertification = action(z.object({}), async () =>
  certificationItem(await prisma.certification.create({ data: { sort: await firstSort(prisma.certification) } })),
);

/** Autosaves a certification. Saving one that was just removed does nothing. */
export const saveCertification = action(certificationFields, async ({ id, ...data }) => {
  await prisma.certification.updateMany({ where: { id }, data });
  return null;
});

export const removeCertification = action(z.object({ id }), async ({ id }) => {
  await prisma.certification.deleteMany({ where: { id } });
  return null;
});

/** Puts a removed certification back; the list then saves its place in the order. */
export const restoreCertification = action(certificationFields, async (entry) =>
  certificationItem(
    await prisma.certification.upsert({
      where: { id: entry.id },
      create: { ...entry, sort: await nextSort(prisma.certification) },
      update: {},
    }),
  ),
);

/** Saves the certifications' order: `ids` is every certification, in the new order. */
export const reorderCertifications = action(z.object({ ids: z.array(id) }), async ({ ids }) => {
  await prisma.$transaction(async (tx) => {
    const known = new Set((await tx.certification.findMany({ select: { id: true } })).map((entry) => entry.id));
    if (ids.length !== known.size || new Set(ids).size !== ids.length || !ids.every((entryId) => known.has(entryId))) {
      throw new ActionError("The list changed in the meantime. Reload the page and try again.");
    }
    for (const [sort, entryId] of ids.entries()) await tx.certification.update({ where: { id: entryId }, data: { sort } });
  });
  return null;
});

// ─── Custom sections (#298) ──────────────────────────────────────────────────

const customItemFields = z.object({
  id,
  sectionId: id,
  title: text(3000),
  subtitle: text(300),
  startYear: year,
  startMonth: month,
  endYear: year,
  endMonth: month,
  current: z.boolean(),
  details: text(10000),
  link: text(500),
  onResumes: z.boolean(),
});

const customItem = (item: z.infer<typeof customItemFields>) => ({
  id: item.id,
  title: item.title,
  subtitle: item.subtitle,
  startYear: item.startYear,
  startMonth: item.startMonth,
  endYear: item.endYear,
  endMonth: item.endMonth,
  current: item.current,
  details: item.details,
  link: item.link,
  onResumes: item.onResumes,
});

/** What shows a section's name and order. */
const revalidateSections = () => {
  revalidatePath("/profile");
  revalidatePath("/resume");
};

const customSectionFields = { title: z.string().trim().min(1, "Give the section a name.").max(100), format: z.enum(CustomSectionFormat) };

/** "Add a section" (#298, #338), on the Profile page. */
export const createCustomSection = action(z.object(customSectionFields), async (data) => {
  const { id } = await prisma.customSection.create({ data, select: { id: true } });
  revalidateSections();
  return id;
});

/**
 * Deletes a section the user made, with its items, leaving resumes not sent
 * yet without it. Its place in the order stays, for Undo.
 */
export const deleteCustomSection = action(z.object({ id }), async ({ id: sectionId }) => {
  await prisma.customSection.deleteMany({ where: { id: sectionId } });
  revalidateSections();
  return null;
});

const restoredItem = z.object({
  id,
  title: z.string().max(3000),
  subtitle: z.string().max(300),
  startYear: z.number().int().nullable(),
  startMonth: z.number().int().nullable(),
  endYear: z.number().int().nullable(),
  endMonth: z.number().int().nullable(),
  current: z.boolean(),
  details: z.string().max(10000),
  link: z.string().max(500),
  onResumes: z.boolean(),
});

/** Undo after deleting a section: it comes back with its items and ids, so resumes that hold it find them again. */
export const restoreCustomSection = action(
  z.object({ id, ...customSectionFields, items: z.array(restoredItem).max(500) }),
  async ({ items, ...section }) => {
    await prisma.$transaction(async (tx) => {
      await tx.customSection.upsert({ where: { id: section.id }, create: section, update: {} });
      // Items still there (Undo pressed twice) stay as they are; SQLite has no skipDuplicates.
      const kept = new Set((await tx.customItem.findMany({ where: { id: { in: items.map((item) => item.id) } }, select: { id: true } })).map((item) => item.id));
      await tx.customItem.createMany({ data: items.filter((item) => !kept.has(item.id)).map((item, sort) => ({ ...item, sectionId: section.id, sort })) });
    });
    revalidateSections();
    return null;
  },
);

const SECTION_GONE = "That section no longer exists. Reload the page to see your sections.";

/** Autosaves a section's name and format. A blank name isn't saved: a resume's heading needs one. */
export const saveCustomSection = action(
  z.object({ id, title: text(100), format: z.enum(CustomSectionFormat) }),
  async ({ id: sectionId, title, format }) => {
    const before = await prisma.customSection.findUnique({ where: { id: sectionId }, select: { format: true } });
    if (!before) return null;
    const section = await prisma.customSection.update({
      where: { id: sectionId },
      data: { format, ...(title.trim() ? { title: title.trim() } : {}) },
      include: { items: { orderBy: [{ sort: "asc" }, { createdAt: "asc" }] } },
    });
    if (before.format !== format) await rewriteSectionOnDrafts(section);
    revalidatePath("/resume");
    return null;
  },
);

/** "+ Add an item": at the end of the section, since nothing in it says what's newest. */
export const createCustomItem = action(z.object({ sectionId: id, title: text(3000).optional() }), async ({ sectionId, title = "" }) => {
  const last = await prisma.customItem.aggregate({ where: { sectionId }, _max: { sort: true } });
  if (!(await prisma.customSection.count({ where: { id: sectionId } }))) throw new ActionError(SECTION_GONE);
  return customItem(await prisma.customItem.create({ data: { sectionId, title, sort: (last._max.sort ?? -1) + 1 } }));
});

/** Autosaves an item. Saving one that was just removed does nothing. */
export const saveCustomItem = action(customItemFields, async ({ id: itemId, ...data }) => {
  await prisma.customItem.updateMany({ where: { id: itemId }, data });
  return null;
});

export const removeCustomItem = action(z.object({ id }), async ({ id: itemId }) => {
  await prisma.customItem.deleteMany({ where: { id: itemId } });
  return null;
});

/** Puts a removed item back; the list then saves its place in the order. */
export const restoreCustomItem = action(customItemFields, async (entry) => {
  if (!(await prisma.customSection.count({ where: { id: entry.sectionId } }))) throw new ActionError(SECTION_GONE);
  const last = await prisma.customItem.aggregate({ where: { sectionId: entry.sectionId }, _max: { sort: true } });
  return customItem(await prisma.customItem.upsert({ where: { id: entry.id }, create: { ...entry, sort: (last._max.sort ?? -1) + 1 }, update: {} }));
});

/** Saves a section's order: `ids` is each of its items, in the new order. */
export const reorderCustomItems = action(z.object({ sectionId: id, ids: z.array(id) }), async ({ sectionId, ids }) => {
  await prisma.$transaction(async (tx) => {
    const known = new Set((await tx.customItem.findMany({ where: { sectionId }, select: { id: true } })).map((entry) => entry.id));
    if (ids.length !== known.size || new Set(ids).size !== ids.length || !ids.every((entryId) => known.has(entryId))) {
      throw new ActionError("The list changed in the meantime. Reload the page and try again.");
    }
    for (const [sort, entryId] of ids.entries()) await tx.customItem.update({ where: { id: entryId }, data: { sort } });
  });
  return null;
});

// ─── Publications (#218) ─────────────────────────────────────────────────────

const publicationFields = z.object({
  id,
  citation: text(3000),
  link: text(500),
  onResumes: z.boolean(),
});

const publicationItem = (entry: z.infer<typeof publicationFields>) => ({
  id: entry.id,
  citation: entry.citation,
  link: entry.link,
  onResumes: entry.onResumes,
});

/** "+ Add a publication": a blank entry at the top, where the newest usually goes. */
export const createPublication = action(z.object({}), async () => publicationItem(await newPublication()));

/** Autosaves a publication. Saving one that was just removed does nothing. */
export const savePublication = action(publicationFields, async ({ id, ...data }) => {
  await prisma.publication.updateMany({ where: { id }, data });
  return null;
});

export const removePublication = action(z.object({ id }), async ({ id }) => {
  await prisma.publication.deleteMany({ where: { id } });
  return null;
});

/** Puts a removed publication back; the list then saves its place in the order. */
export const restorePublication = action(publicationFields, async (entry) => publicationItem(await restorePublicationEntry(entry)));

/** Saves the publications' order: `ids` is every publication, in the new order. */
export const reorderPublications = action(z.object({ ids: z.array(id) }), async ({ ids }) => {
  await reorderPublicationList(ids);
  return null;
});

// ─── Order (E4-9) ────────────────────────────────────────────────────────────

const section = z.enum(["experience", "project", "education"]);

/**
 * Saves an order set by hand: `ids` is every entry of the section, in the new
 * order. From then on the section keeps that order instead of dates.
 */
export const reorderEntries = action(z.object({ section, ids: z.array(id) }), async ({ section, ids }) => {
  await reorderSection(section, ids);
  return null;
});

/** Goes back to date order; returns the section's ids in that order for the list. */
export const sortEntriesByDate = action(z.object({ section }), ({ section }) => sortSectionByDate(section));

// ─── Import from a resume (E4-10) ───────────────────────────────────────────

/**
 * Merges the profile read from a resume into the profile, or replaces it,
 * from the reading its job keeps (applyProfileImportJob); the job goes then,
 * with the resume's text.
 */
export const applyProfileImport = action(
  z.object({ jobId: id, mode: z.enum(["merge", "replace"]) }),
  async ({ jobId, mode }, { toast }) => {
    const profile = await applyProfileImportJob(jobId, mode);
    revalidatePath("/", "layout");
    toast(`${mode === "replace" ? "Your profile now holds" : "Added to your profile"}: ${importCounts(profile)}.`);
    return null;
  },
);

/** "Choose another file": the reading is deleted, with the resume's text, and stopped if it's under way. */
export const discardProfileImport = action(z.object({ jobId: id }), async ({ jobId }) => {
  await discardProfileImports(jobId);
  return null;
});

// ─── References (PRO-8) ──────────────────────────────────────────────────────

const referenceFields = z.object({
  id,
  name: text(200),
  relation: text(200),
  company: text(200),
  email: text(320),
  phone: text(60),
});

const referenceItem = (entry: z.infer<typeof referenceFields>) => ({
  id: entry.id,
  name: entry.name,
  relation: entry.relation,
  company: entry.company,
  email: entry.email,
  phone: entry.phone,
});

export const createReference = action(z.object({}), async () => referenceItem(await newReference()));

export const saveReference = action(referenceFields, async ({ id, ...data }) => {
  await prisma.reference.updateMany({ where: { id }, data });
  return null;
});

export const removeReference = action(z.object({ id }), async ({ id }) => {
  await prisma.reference.deleteMany({ where: { id } });
  return null;
});

export const restoreReference = action(referenceFields, async (entry) => referenceItem(await restoreReferenceEntry(entry)));
