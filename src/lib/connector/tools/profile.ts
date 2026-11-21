import "server-only";

import { z } from "zod";

import { JobStatus, LanguageLevel } from "@/generated/prisma/enums";
import { ActionError } from "@/lib/action";
import { isAiUsable, loadAiConfig } from "@/lib/ai/config";
import { providerOption } from "@/lib/ai/provider-options";
import { citationText } from "@/lib/citation";
import { addFact } from "@/lib/facts";
import { countryCodeFor } from "@/lib/job-search/countries";
import { RADII_KM } from "@/lib/job-search/search";
import { applyProfileImportJob, discardProfileImports, importProfileJob } from "@/lib/jobs/import-profile";
import { startJob } from "@/lib/jobs/runner";
import { PHOTO_KEY, PHOTO_ON_RESUMES_KEY, photoFromFields } from "@/lib/photo";
import { prisma } from "@/lib/prisma";
import {
  BASICS_FIELDS,
  type Basics,
  type BasicsField,
  type DateSpan,
  type FactItem,
  type ProfileData,
} from "@/lib/profile";
import { loadProfile } from "@/lib/profile-data";
import {
  addOrUpdateLanguage,
  deletePhoto,
  newCertification,
  newCustomItem,
  newEducation,
  newExperience,
  newProject,
  newPublication,
  newReference,
  ORDER_SETTING,
  photoOnResumesRow,
  reorderCertificationList,
  reorderCustomItemList,
  reorderPublicationList,
  reorderSection,
  restoreCertificationEntry,
  restoreCustomItemEntry,
  restoreEducationEntry,
  restoreExperienceEntry,
  restoreProjectEntry,
  restorePublicationEntry,
  restoreReferenceEntry,
  saveBasicsFields,
  sortSectionByDate,
  storePhoto,
} from "@/lib/profile-edits";
import { findOrCreateSkill } from "@/lib/profile-entries";
import { importCounts, type ImportedProfile, type ImportMode } from "@/lib/profile-import";
import { levelRange, levelRangeLabel, PROFILE_LEVELS, type ProfileLevel } from "@/lib/profile-levels";
import { workplaceSchema, type WorkMode } from "@/lib/profile-workplace";
import { listProfiles, loadProfileLevels, loadProfileSettings, loadProfileWorkplace, saveProfileLevels, saveProfileWorkplace } from "@/lib/profiles";
import { sectionName } from "@/lib/resume-sections";
import { RESUME_MESSAGES, resumeText } from "@/lib/resume-text";
import { seniorityAndLocation } from "@/lib/scoring/questions";

import { chooseProfile, failure, profileInput, started, text, type ToolContext } from "../kit";
import { connectorSince } from "../oauth";
import { forgetRemoved, keepRemoved, keptRemoved, type Removed } from "../removed-entries";

// The profile: reading it, and editing it as the Profile and Import screens
// do (jobauto fork). Contact details go in but don't come out: Claude reads
// which are filled in, never their values, and a reference's email and phone
// stay in Dossier the same way. Links are left out like on the AI's prompts.
// With several profiles (E24-1), each tool takes one by name, the first
// without; the name, contact details, photo, languages and facts are every
// profile's, the rest the profile's own.

/** The entries save_profile_entry and remove_profile_entry work on; a section_item is an item of a section the user made (#298). */
const ENTRY_KINDS = ["experience", "project", "education", "certification", "publication", "reference", "section_item"] as const;
type EntryKind = (typeof ENTRY_KINDS)[number];

/** Each kind's list in get_profile, and its section on the Profile screen (?section=), but for volunteering and a section's items (sectionOf). */
const SECTION = {
  experience: "experience",
  project: "projects",
  education: "education",
  certification: "certifications",
  publication: "publications",
  reference: "references",
  section_item: "other_sections",
} as const;

/** What each kind is called in answers. */
const NOUN: Record<EntryKind, string> = {
  experience: "role",
  project: "project",
  education: "education entry",
  certification: "certification",
  publication: "publication",
  reference: "reference",
  section_item: "item",
};

/** An entry's section on the Profile screen: volunteering has its own (#294), and so does each section the user made. */
function sectionOf(kind: EntryKind, entry: { volunteering?: boolean; sectionId?: string } = {}): string {
  if (kind === "experience" && entry.volunteering) return "volunteering";
  if (kind === "section_item") return entry.sectionId ? `custom:${entry.sectionId}` : "basics";
  return SECTION[kind];
}

/** Long text cut to a title's length, as a publication's citation is. */
const shortTitle = (value: string) => (value.length > 80 ? `${value.slice(0, 79)}…` : value);

const filled = (value: string | undefined) => Boolean(value?.trim());

/** The tool's names for the Basics fields whose own names differ. */
const TOOL_NAMES: Partial<Record<BasicsField, string>> = { dob: "date_of_birth", houseNumber: "house_number", postalCode: "postal_code" };

/** The fields Claude gave, without the ones it left out. */
function given<T extends object>(fields: T): { [K in keyof T]?: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) as { [K in keyof T]?: Exclude<T[K], undefined> };
}

/** An entry's points, one per line, without blank ones. */
const points = (bullets: string) =>
  bullets
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

/** The profile's photo, or null without one. */
const loadPhoto = async () => photoFromFields(await prisma.profileField.findMany({ where: { key: { in: [PHOTO_KEY, PHOTO_ON_RESUMES_KEY] } } }));

// ─── Dates ───────────────────────────────────────────────────────────────────
// Claude reads and writes an entry's dates as "2021-03", or "2021" when only
// the year is known; `current` is "Present".

const MONTH_YEAR = /^((?:19|20)\d\d)(?:-(0[1-9]|1[0-2]))?$/;
/** A date in a tool's input: as above, or "" to clear it. */
const MONTH_YEAR_INPUT = /^(?:(?:19|20)\d\d(?:-(?:0[1-9]|1[0-2]))?)?$/;

function monthYear(year: number | null, month: number | null): string | null {
  if (year === null) return null;
  return month === null ? String(year) : `${year}-${String(month).padStart(2, "0")}`;
}

const datesOf = (entry: DateSpan) => ({ start: monthYear(entry.startYear, entry.startMonth), end: monthYear(entry.endYear, entry.endMonth), current: entry.current });

/** The year and month of "2021-03" or "2021"; nulls for "". */
function yearAndMonth(value: string): { year: number | null; month: number | null } {
  const match = MONTH_YEAR.exec(value);
  return { year: match ? Number(match[1]) : null, month: match?.[2] ? Number(match[2]) : null };
}

/** The dates Claude gave, as the table's columns. */
function spanColumns({ start, end, current }: { start?: string; end?: string; current?: boolean }) {
  const from = start === undefined ? undefined : yearAndMonth(start);
  const to = end === undefined ? undefined : yearAndMonth(end);
  return {
    ...(from && { startYear: from.year, startMonth: from.month }),
    ...(to && { endYear: to.year, endMonth: to.month }),
    ...(current === undefined ? {} : { current }),
  };
}

// ─── What Claude reads ───────────────────────────────────────────────────────

/** Which of the user's contact details are filled in, never their values. */
function contactDetails(basics: Partial<Record<BasicsField, string>>) {
  return {
    email: filled(basics.email),
    phone: filled(basics.phone),
    street: filled(basics.street),
    house_number: filled(basics.houseNumber),
    postal_code: filled(basics.postalCode),
    city: filled(basics.city),
    country: filled(basics.country),
    website: filled(basics.website),
    linkedin: filled(basics.linkedin),
    date_of_birth: filled(basics.dob),
  };
}

const basedIn = (basics: Partial<Record<BasicsField, string>>) => [basics.city, basics.country].filter(filled).join(", ");

/** The profile as get_profile shows it: what writing needs, with the ids and values the profile tools take. */
function profileView(profile: ProfileData) {
  // In the order of the profile's skills, as the screen lists them.
  const skillsOf = (ids: string[]) => profile.skills.filter((skill) => ids.includes(skill.id)).map((skill) => skill.name);
  const { basics } = profile;
  return {
    name: basics.name,
    headline: basics.headline,
    based_in: basedIn(basics),
    summary: basics.summary,
    contact_details: contactDetails(basics),
    show_age: basics.showAge,
    photo: profile.photo ? { on_resumes: profile.photo.onResumes } : null,
    facts_about_me: profile.facts,
    skills: profile.skills.map((skill) => skill.name),
    languages: profile.languages.map(({ name, level }) => ({ name, level })),
    experience: profile.experience.map((entry) => ({
      id: entry.id,
      role: entry.role,
      company: entry.company,
      location: entry.location,
      // One line about the company or the role, as written (#257); volunteering is unpaid (#294).
      about: entry.descriptor.trim() || undefined,
      volunteering: entry.volunteering || undefined,
      ...datesOf(entry),
      bullets: points(entry.bullets),
      skills: skillsOf(entry.skillIds),
    })),
    projects: profile.projects.map((entry) => ({
      id: entry.id,
      name: entry.name,
      has_link: filled(entry.link),
      ...datesOf(entry),
      bullets: points(entry.bullets),
      skills: skillsOf(entry.skillIds),
    })),
    education: profile.education.map((entry) => ({ id: entry.id, degree: entry.degree, school: entry.school, ...datesOf(entry), notes: entry.notes })),
    // Without their credential IDs and links (#293).
    certifications: profile.certifications.map((entry) => ({
      id: entry.id,
      name: entry.name,
      issuer: entry.issuer,
      obtained: monthYear(entry.year, entry.month),
      valid_until: monthYear(entry.expiryYear, entry.expiryMonth),
      has_link: filled(entry.link),
      on_resumes: entry.onResumes,
    })),
    publications: profile.publications.map((entry) => ({ id: entry.id, citation: entry.citation, has_link: filled(entry.link), on_resumes: entry.onResumes })),
    // Sections the user made (#298), such as Awards; only an Entries section's items have more than a title.
    other_sections: profile.customSections.map((section) => ({
      id: section.id,
      title: section.title,
      format: section.format.toLowerCase(),
      items: section.items.map((item) => ({
        id: item.id,
        title: item.title,
        ...(section.format === "ENTRIES" ? { subtitle: item.subtitle, ...datesOf(item), details: points(item.details) } : {}),
        has_link: filled(item.link),
        on_resumes: item.onResumes,
      })),
    })),
    references: profile.references.map((entry) => ({
      id: entry.id,
      name: entry.name,
      relation: entry.relation,
      company: entry.company,
      has_email: filled(entry.email),
      has_phone: filled(entry.phone),
    })),
  };
}

/** Each entry of a kind with how answers name it, in the profile's order. */
function titles(profile: ProfileData, kind: EntryKind): { id: string; title: string }[] {
  const joined = (parts: string[], separator: string) =>
    parts
      .map((part) => part.trim())
      .filter(Boolean)
      .join(separator);
  switch (kind) {
    case "experience":
      return profile.experience.map((entry) => ({ id: entry.id, title: joined([entry.role, entry.company], " at ") || "New role" }));
    case "project":
      return profile.projects.map((entry) => ({ id: entry.id, title: entry.name.trim() || "New project" }));
    case "education":
      return profile.education.map((entry) => ({ id: entry.id, title: joined([entry.degree, entry.school], ", ") || "New entry" }));
    case "certification":
      return profile.certifications.map((entry) => ({ id: entry.id, title: entry.name.trim() || "New certification" }));
    case "publication":
      return profile.publications.map((entry) => ({ id: entry.id, title: shortTitle(citationText(entry.citation)) || "New publication" }));
    case "reference":
      return profile.references.map((entry) => ({ id: entry.id, title: entry.name.trim() || "New reference" }));
    case "section_item":
      return profile.customSections.flatMap((section) => section.items.map((item) => ({ id: item.id, title: shortTitle(item.title.trim()) || "New item" })));
  }
}

/** What a resume reading found, shown like get_profile: no contact details or links, and `check` where a word isn't in the resume. */
function importView({ basics, ...profile }: ImportedProfile) {
  const check = (unverified: string[]) => (unverified.length > 0 ? unverified : undefined);
  const unchecked = profile.skills.filter((skill) => !skill.found).map((skill) => skill.name);
  return {
    name: basics.name,
    headline: basics.headline,
    based_in: basedIn(basics) || undefined,
    summary: basics.summary,
    contact_details: contactDetails(basics),
    skills: profile.skills.map((skill) => skill.name),
    skills_to_check: unchecked.length > 0 ? unchecked : undefined,
    languages: profile.languages.map(({ name, level, levelGiven }) => ({ name, level, level_given: levelGiven ? undefined : false })),
    experience: profile.experience.map((entry) => ({
      role: entry.role,
      company: entry.company,
      location: entry.location,
      about: entry.descriptor.trim() || undefined,
      volunteering: entry.volunteering || undefined,
      ...datesOf(entry),
      bullets: points(entry.bullets),
      skills: entry.skills,
      check: check(entry.unverified),
    })),
    projects: profile.projects.map((entry) => ({
      name: entry.name,
      has_link: filled(entry.link),
      ...datesOf(entry),
      bullets: points(entry.bullets),
      skills: entry.skills,
      check: check(entry.unverified),
    })),
    education: profile.education.map((entry) => ({ degree: entry.degree, school: entry.school, ...datesOf(entry), notes: entry.notes, check: check(entry.unverified) })),
    certifications: profile.certifications.map((entry) => ({
      name: entry.name,
      issuer: entry.issuer,
      obtained: monthYear(entry.year, entry.month),
      valid_until: monthYear(entry.expiryYear, entry.expiryMonth),
      has_link: filled(entry.link),
      check: check(entry.unverified),
    })),
    publications: profile.publications.map((entry) => ({ citation: entry.citation, has_link: filled(entry.link), check: check(entry.unverified) })),
    references: profile.references.map((entry) => ({
      name: entry.name,
      relation: entry.relation,
      company: entry.company,
      has_email: filled(entry.email),
      has_phone: filled(entry.phone),
      check: check(entry.unverified),
    })),
    // What the reading didn't keep, and why (#371), as the Import screen lists it.
    left_out: profile.leftOut.length > 0 ? profile.leftOut : undefined,
  };
}

// ─── Undo for remove_profile_entry ───────────────────────────────────────────
// What it takes out stays in the server's memory for an hour
// (../removed-entries.ts), so a reference's email and phone never reach Claude.

/** The entry with that id in the profile and its place, as remove_profile_entry keeps it; null when there's none. */
function findEntry(profile: ProfileData, profileId: string, kind: EntryKind, id: string): Removed | null {
  const listed = titles(profile, kind);
  const position = listed.findIndex((entry) => entry.id === id);
  if (position < 0) return null;
  const { title } = listed[position];
  switch (kind) {
    case "experience":
      return { kind, entry: profile.experience[position], position, title, profileId };
    case "project":
      return { kind, entry: profile.projects[position], position, title, profileId };
    case "education":
      return { kind, entry: profile.education[position], position, title, profileId };
    case "certification":
      return { kind, entry: profile.certifications[position], position, title, profileId };
    case "publication":
      return { kind, entry: profile.publications[position], position, title, profileId };
    case "reference":
      return { kind, entry: profile.references[position], position, title, profileId };
    case "section_item": {
      // Its place is within its own section.
      const section = profile.customSections.find((custom) => custom.items.some((item) => item.id === id))!;
      const index = section.items.findIndex((item) => item.id === id);
      return { kind, entry: section.items[index], position: index, title, profileId, sectionId: section.id };
    }
  }
}

/** Removes an entry of the profile, as the screen's Remove does. */
async function deleteEntry(profileId: string, kind: EntryKind, id: string): Promise<void> {
  const where = { id, profileId };
  if (kind === "experience") await prisma.experience.deleteMany({ where });
  else if (kind === "project") await prisma.project.deleteMany({ where });
  else if (kind === "education") await prisma.education.deleteMany({ where });
  else if (kind === "certification") await prisma.certification.deleteMany({ where });
  else if (kind === "publication") await prisma.publication.deleteMany({ where });
  else if (kind === "reference") await prisma.reference.deleteMany({ where });
  else await prisma.customItem.deleteMany({ where: { id, section: { profileId } } });
}

/** Back in its place where the order is set by hand, as the screen's Undo does; in date order, its dates place it. References keep no order. */
async function backInPlace(removed: Exclude<Removed, { kind: "reference" | "photo" }>): Promise<void> {
  const { profileId, position } = removed;
  const { id } = removed.entry;
  const dated = removed.kind === "experience" || removed.kind === "project" || removed.kind === "education";
  if (dated && (await loadProfileSettings(profileId))[ORDER_SETTING[removed.kind]] !== "manual") return;
  const profile = await loadProfile(profileId);
  // A section's items are ordered within it.
  const listed = removed.kind === "section_item" ? (profile.customSections.find((section) => section.id === removed.sectionId)?.items ?? []) : titles(profile, removed.kind);
  const ids = listed.map((entry) => entry.id).filter((entryId) => entryId !== id);
  ids.splice(Math.min(position, ids.length), 0, id);
  if (removed.kind === "publication") await reorderPublicationList(profileId, ids);
  else if (removed.kind === "certification") await reorderCertificationList(profileId, ids);
  else if (removed.kind === "section_item") await reorderCustomItemList(removed.sectionId, ids);
  else await reorderSection(profileId, removed.kind, ids);
}

/** Puts back what remove_profile_entry took out, into the profile it was in. */
async function putBack(removed: Removed): Promise<void> {
  const { profileId } = removed;
  switch (removed.kind) {
    case "experience":
      await restoreExperienceEntry(profileId, removed.entry);
      return backInPlace(removed);
    case "project":
      await restoreProjectEntry(profileId, removed.entry);
      return backInPlace(removed);
    case "education":
      await restoreEducationEntry(profileId, removed.entry);
      return backInPlace(removed);
    case "certification":
      await restoreCertificationEntry(profileId, removed.entry);
      return backInPlace(removed);
    case "publication":
      await restorePublicationEntry(profileId, removed.entry);
      return backInPlace(removed);
    case "section_item":
      // remove_profile_entry checks first that its section is still there.
      await restoreCustomItemEntry(removed.sectionId, removed.entry);
      return backInPlace(removed);
    case "reference":
      await restoreReferenceEntry(profileId, removed.entry);
      return;
    case "photo":
      return storePhoto(removed.entry.src, removed.entry.onResumes);
  }
}

// ─── Saving entries ──────────────────────────────────────────────────────────

// What each field means is said once, in save_profile_entry's description.
const text100 = z.string().trim().max(100);
const entryId = z.string().min(1).max(100).optional();
const monthYearInput = z.string().regex(MONTH_YEAR_INPUT, "Use 'YYYY-MM', 'YYYY', or '' to clear it.").optional();
const spanInput = { start: monthYearInput, end: monthYearInput, current: z.boolean().optional() };
const pointsInput = z
  .array(z.string().trim().max(1000))
  .max(40)
  .refine((list) => list.join("\n").length <= 10_000, "Keep the points under 10,000 characters together.")
  .optional();
const skillsInput = z.array(text100.min(1)).max(40).optional();

const experienceInput = z.object({
  id: entryId,
  role: z.string().trim().max(200).optional(),
  company: z.string().trim().max(200).optional(),
  location: z.string().trim().max(200).optional(),
  volunteering: z.boolean().optional().describe("Unpaid: under Volunteering, and not counted as years of paid work"),
  ...spanInput,
  bullets: pointsInput,
  skills: skillsInput,
});
const projectInput = z.object({
  id: entryId,
  name: z.string().trim().max(200).optional(),
  link: z.string().trim().max(500).optional().describe("Where to see it, e.g. its repository or site"),
  ...spanInput,
  bullets: pointsInput,
  skills: skillsInput,
});
const educationInput = z.object({
  id: entryId,
  degree: z.string().trim().max(200).optional().describe("A degree, course or certificate"),
  school: z.string().trim().max(200).optional(),
  ...spanInput,
  notes: z.string().trim().max(5000).optional(),
});
const publicationInput = z.object({
  id: entryId,
  citation: z.string().trim().max(3000).optional().describe("As the user cites it, with **bold** and *italic*"),
  link: z.string().trim().max(500).optional().describe("Where to read it, e.g. its DOI link"),
  on_resumes: z.boolean().optional().describe("Shown on resumes; on for a new one"),
});
const referenceInput = z.object({
  id: entryId,
  name: z.string().trim().max(200).optional(),
  relation: z.string().trim().max(200).optional().describe("e.g. 'Former manager'"),
  company: z.string().trim().max(200).optional(),
  email: z.string().trim().max(320).optional(),
  phone: z.string().trim().max(60).optional(),
});
const certificationInput = z.object({
  id: entryId,
  name: z.string().trim().max(300).optional(),
  issuer: z.string().trim().max(200).optional(),
  obtained: monthYearInput,
  valid_until: monthYearInput.describe("When it runs out; '' when it doesn't"),
  credential_id: z.string().trim().max(200).optional(),
  link: z.string().trim().max(500).optional().describe("Where to verify it"),
  on_resumes: z.boolean().optional().describe("Shown on resumes; on for a new one"),
});
const sectionItemInput = z.object({
  id: entryId,
  section_id: z.string().min(1).max(100).optional().describe("For a new item: its section, from get_profile's other_sections"),
  title: z.string().trim().max(3000).optional(),
  subtitle: z.string().trim().max(300).optional().describe("Where or with whom"),
  ...spanInput,
  details: pointsInput,
  link: z.string().trim().max(500).optional(),
  on_resumes: z.boolean().optional().describe("Shown on resumes; on for a new one"),
});

const lines = (bullets: string[] | undefined) => (bullets === undefined ? {} : { bullets: bullets.filter(Boolean).join("\n") });

/** A certification's dates as the table's columns. */
function certificationDates({ obtained, valid_until }: { obtained?: string; valid_until?: string }) {
  const from = obtained === undefined ? undefined : yearAndMonth(obtained);
  const until = valid_until === undefined ? undefined : yearAndMonth(valid_until);
  return { ...(from && { year: from.year, month: from.month }), ...(until && { expiryYear: until.year, expiryMonth: until.month }) };
}

/** Sets the skills used in a role or project, by name, adding the ones the profile doesn't have yet (PRO-6); answers with those. */
async function setSkillsUsed(profileId: string, kind: "experience" | "project", id: string, names: string[]): Promise<string[]> {
  const found = [];
  for (const name of names) found.push(await findOrCreateSkill(profileId, name));
  const skillIds = [...new Set(found.map(({ skill }) => skill.id))];
  // Only the links it doesn't have yet are made: SQLite can't skip duplicates.
  if (kind === "experience") {
    const linked = new Set((await prisma.experienceSkill.findMany({ where: { experienceId: id }, select: { skillId: true } })).map((link) => link.skillId));
    await prisma.$transaction([
      prisma.experienceSkill.deleteMany({ where: { experienceId: id, skillId: { notIn: skillIds } } }),
      prisma.experienceSkill.createMany({ data: skillIds.filter((skillId) => !linked.has(skillId)).map((skillId) => ({ experienceId: id, skillId })) }),
    ]);
  } else {
    const linked = new Set((await prisma.projectSkill.findMany({ where: { projectId: id }, select: { skillId: true } })).map((link) => link.skillId));
    await prisma.$transaction([
      prisma.projectSkill.deleteMany({ where: { projectId: id, skillId: { notIn: skillIds } } }),
      prisma.projectSkill.createMany({ data: skillIds.filter((skillId) => !linked.has(skillId)).map((skillId) => ({ projectId: id, skillId })) }),
    ]);
  }
  return found.filter(({ added }) => added).map(({ skill }) => skill.name);
}

type EntryInput = {
  experience?: z.output<typeof experienceInput>;
  project?: z.output<typeof projectInput>;
  education?: z.output<typeof educationInput>;
  certification?: z.output<typeof certificationInput>;
  publication?: z.output<typeof publicationInput>;
  reference?: z.output<typeof referenceInput>;
  section_item?: z.output<typeof sectionItemInput>;
};

/**
 * Saves one entry as the screen's "+ Add" and autosave do: a new one is
 * placed like one added there, then gets its fields. Answers with its id and
 * the skills that joined the profile, or null when the id is no longer there.
 */
async function saveEntry(profileId: string, kind: EntryKind, input: EntryInput): Promise<{ id: string; newSkills: string[] } | null> {
  // Only an entry of this profile changes (E24-1).
  const own = (entryId: string) => ({ id: entryId, profileId });
  if (kind === "experience" && input.experience) {
    const { id, skills, bullets, start, end, current, ...fields } = input.experience;
    const entryId = id ?? (await newExperience(profileId)).id;
    const data = { ...given(fields), ...lines(bullets), ...spanColumns({ start, end, current }) };
    if ((await prisma.experience.updateMany({ where: own(entryId), data })).count === 0) return null;
    return { id: entryId, newSkills: skills ? await setSkillsUsed(profileId, kind, entryId, skills) : [] };
  }
  if (kind === "project" && input.project) {
    const { id, skills, bullets, start, end, current, ...fields } = input.project;
    const entryId = id ?? (await newProject(profileId)).id;
    const data = { ...given(fields), ...lines(bullets), ...spanColumns({ start, end, current }) };
    if ((await prisma.project.updateMany({ where: own(entryId), data })).count === 0) return null;
    return { id: entryId, newSkills: skills ? await setSkillsUsed(profileId, kind, entryId, skills) : [] };
  }
  if (kind === "education" && input.education) {
    const { id, start, end, current, ...fields } = input.education;
    const entryId = id ?? (await newEducation(profileId)).id;
    const data = { ...given(fields), ...spanColumns({ start, end, current }) };
    return (await prisma.education.updateMany({ where: own(entryId), data })).count === 0 ? null : { id: entryId, newSkills: [] };
  }
  if (kind === "publication" && input.publication) {
    const { id, on_resumes, ...fields } = input.publication;
    const entryId = id ?? (await newPublication(profileId)).id;
    const data = { ...given(fields), ...(on_resumes === undefined ? {} : { onResumes: on_resumes }) };
    return (await prisma.publication.updateMany({ where: own(entryId), data })).count === 0 ? null : { id: entryId, newSkills: [] };
  }
  if (kind === "reference" && input.reference) {
    const { id, ...fields } = input.reference;
    const entryId = id ?? (await newReference(profileId)).id;
    return (await prisma.reference.updateMany({ where: own(entryId), data: given(fields) })).count === 0 ? null : { id: entryId, newSkills: [] };
  }
  if (kind === "certification" && input.certification) {
    const { id, obtained, valid_until, credential_id, on_resumes, ...fields } = input.certification;
    const entryId = id ?? (await newCertification(profileId)).id;
    const data = { ...given(fields), ...given({ credentialId: credential_id, onResumes: on_resumes }), ...certificationDates({ obtained, valid_until }) };
    return (await prisma.certification.updateMany({ where: own(entryId), data })).count === 0 ? null : { id: entryId, newSkills: [] };
  }
  if (kind === "section_item" && input.section_item) {
    const { id, section_id, details, start, end, current, on_resumes, ...fields } = input.section_item;
    // A new item goes into one of this profile's sections; the tool checks section_id first.
    const entryId = id ?? (await newCustomItem(section_id!))?.id;
    if (!entryId) return null;
    const data = { ...given(fields), ...(details === undefined ? {} : { details: details.filter(Boolean).join("\n") }), ...given({ onResumes: on_resumes }), ...spanColumns({ start, end, current }) };
    return (await prisma.customItem.updateMany({ where: { id: entryId, section: { profileId } }, data })).count === 0 ? null : { id: entryId, newSkills: [] };
  }
  return null;
}

/** The entry as get_profile lists it, with what places it on the Profile screen. */
function listedEntry(profile: ProfileData, kind: EntryKind, id: string): ({ id: string } & Record<string, unknown>) | undefined {
  const view = profileView(profile);
  if (kind === "section_item") {
    const section = view.other_sections.find((custom) => custom.items.some((item) => item.id === id));
    const item = section?.items.find((entry) => entry.id === id);
    return item && section ? { ...item, section_id: section.id, section: section.title } : undefined;
  }
  const listed: ({ id: string } & Record<string, unknown>)[] = view[SECTION[kind]];
  return listed.find((entry) => entry.id === id);
}

/** For an id that isn't in the profile. */
const noSuchEntry = (kind: EntryKind) => failure(`There's no such ${NOUN[kind]} in the profile. get_profile lists them with their ids.`);

/** The Profile screen's section a removed entry was in. */
function removedSection(removed: Removed): string {
  if (removed.kind === "photo") return "basics";
  if (removed.kind === "experience") return sectionOf(removed.kind, removed.entry);
  if (removed.kind === "section_item") return sectionOf(removed.kind, { sectionId: removed.sectionId });
  return sectionOf(removed.kind);
}

// ─── The jobs a profile is for (E24-3, E24-4) ────────────────────────────────

const LEVEL_VALUES = PROFILE_LEVELS.map((level) => level.value) as [ProfileLevel, ...ProfileLevel[]];

/** The tool's names for the ways of working. */
const WAYS_OF_WORKING = { onsite: "ONSITE", hybrid: "HYBRID", remote: "REMOTE" } as const satisfies Record<string, WorkMode>;

// ─── Sorting ─────────────────────────────────────────────────────────────────

const SORTABLE = { experience: "experience", projects: "project", education: "education", publications: "publication" } as const;

// ─── The tools ───────────────────────────────────────────────────────────────

/** Registers these tools on the connector's server. */
export function registerProfileTools({ server, linkTo }: ToolContext): void {
  const sectionLink = (profileId: string, section: string) => linkTo(`/profile?profile=${profileId}&section=${section}`);

  server.registerTool(
    "get_profile",
    {
      title: "Read the profile",
      description:
        "The user's profile in Dossier, with the ids save_application and the profile tools use: headline, summary, facts about them, skills, languages, experience and volunteering, projects, education, certifications, publications, sections they made and references. " +
        "Contact details, links and references' email and phone are left out; contact_details says which of the user's own are filled in. " +
        "sections_off_resumes names the sections turned off on the profile's base resume: leave them out of what you write, as save_application does. " +
        "Once the levels it's for are set (set_profile_levels), it also has those levels, the years of paid work and where it wants to work, which save_job_scores judges against. " +
        "The user can have several profiles, one per kind of job; the answer names them all. Without profile it's the first.",
      inputSchema: z.object({ profile: profileInput }),
      annotations: { readOnlyHint: true },
    },
    async (input) => {
      const chosen = await chooseProfile(input.profile);
      if ("failure" in chosen) return chosen.failure;
      const [profile, own, all, levels, { workplace }] = await Promise.all([
        loadProfile(chosen.id),
        loadProfileSettings(chosen.id),
        listProfiles(),
        loadProfileLevels(chosen.id),
        loadProfileWorkplace(chosen.id),
      ]);
      // All of it, for the profile tools' ids; what's off on the base resume (#297) is named, for writing.
      const off = own.resumeSections.off.map((key) => sectionName(key, profile.customSections));
      // What save_job_scores judges seniority and location against, as Dossier's scoring models read it (1.15.1).
      const target = levels ? seniorityAndLocation({ data: profile, levels, workplace }) : null;
      return text({
        profile: chosen.name,
        ...(all.length > 1 ? { profiles: all.map((entry) => entry.name) } : {}),
        ...profileView(profile),
        sections_off_resumes: off.length > 0 ? off : undefined,
        ...(target
          ? { jobsItsFor: target.seniority.levels, yearsOfPaidWork: target.seniority.yearsOfPaidWork, whereItWantsToWork: target.location }
          : { levels_not_set: "Nothing is scored against this profile until its levels are set: ask the user which, then set_profile_levels." }),
        link: linkTo(`/profile?profile=${chosen.id}`),
      });
    },
  );

  server.registerTool(
    "update_profile_basics",
    {
      title: "Change the profile's basics",
      description:
        "Changes the profile's name, headline, summary and contact details, and whether resumes show the age and the photo. " +
        "The headline and summary are the profile's own; the name, contact details, age and photo are every profile's. " +
        "Only the fields given change ('' clears one); answers with the fields that changed, without their values. " +
        "Save only what the user told you or confirmed; never add experience, numbers or facts they didn't give.",
      inputSchema: z.object({
        profile: profileInput.describe("The profile whose headline and summary change; the first when left out"),
        name: z.string().trim().max(200).optional(),
        headline: z.string().trim().max(300).optional().describe("e.g. 'Senior Product Designer'"),
        summary: z.string().trim().max(5000).optional().describe("A few lines about the user"),
        email: z.string().trim().max(320).optional(),
        phone: z.string().trim().max(60).optional(),
        street: z.string().trim().max(200).optional().describe("The street's name, without the house number"),
        house_number: z.string().trim().max(20).optional(),
        postal_code: z.string().trim().max(20).optional().describe("The PLZ"),
        city: z.string().trim().max(120).optional().describe("The city the user lives in"),
        country: z.string().trim().max(120).optional(),
        website: z.string().trim().max(500).optional(),
        linkedin: z.string().trim().max(500).optional().describe("e.g. 'linkedin.com/in/janedoe'"),
        date_of_birth: z.union([z.literal(""), z.iso.date()]).optional().describe("YYYY-MM-DD"),
        show_age: z.boolean().optional().describe("Show the age, from the date of birth, on resumes"),
        photo_on_resumes: z.boolean().optional().describe("Show the photo on resumes; it stays in the profile either way"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ profile: asked, date_of_birth, house_number, postal_code, show_age, photo_on_resumes, ...fields }) => {
      const chosen = await chooseProfile(asked);
      if ("failure" in chosen) return chosen.failure;
      const changes: Partial<Basics> = {
        ...given(fields),
        ...given({ houseNumber: house_number, postalCode: postal_code }),
        ...(date_of_birth === undefined ? {} : { dob: date_of_birth }),
        ...(show_age === undefined ? {} : { showAge: show_age }),
      };
      if (Object.keys(changes).length === 0 && photo_on_resumes === undefined) return failure("Give at least one field to change.");
      const photo = photo_on_resumes === undefined ? null : await loadPhoto();
      if (photo_on_resumes !== undefined && !photo) return failure("There's no photo in the profile. The user can add one on the Profile screen.");

      // The shared basics with the profile's own headline and summary, the address read from the old one-line address until the next save.
      const before = (await loadProfile(chosen.id)).basics;
      const after: Basics = { ...before, ...changes };
      const changed: string[] = BASICS_FIELDS.filter((field) => after[field] !== before[field]).map((field) => TOOL_NAMES[field] ?? field);
      if (after.showAge !== before.showAge) changed.push("show_age");
      if (changed.length > 0) await saveBasicsFields(chosen.id, after);
      if (photo && photo_on_resumes !== undefined && photo.onResumes !== photo_on_resumes) {
        await photoOnResumesRow(photo_on_resumes);
        changed.push("photo_on_resumes");
      }
      return text({ profile: chosen.name, changed, link: sectionLink(chosen.id, "basics") });
    },
  );

  const places = z.array(z.string().trim().min(1).max(100)).max(20).optional();
  server.registerTool(
    "set_profile_levels",
    {
      title: "Set the jobs a profile is for",
      description:
        "Sets the levels a profile is for, and where it wants to work, as Profile → Jobs it's for does; nothing is scored against a profile until its levels are set. " +
        "Only the fields given change. Save only what the user told you or confirmed.",
      inputSchema: z.object({
        profile: profileInput,
        levels: z
          .object({ from: z.enum(LEVEL_VALUES), to: z.enum(LEVEL_VALUES) })
          .optional()
          .describe("A range, e.g. from mid to senior; the same level twice for one"),
        ways_of_working: z.array(z.enum(["onsite", "hybrid", "remote"])).min(1).max(3).optional(),
        within_km: z.literal(RADII_KM).optional().describe("On-site and hybrid: how far from the city in the user's address"),
        other_places: places.describe("On-site and hybrid: other cities or countries too"),
        remote_for: z.enum(["country", "countries", "anywhere"]).optional().describe("Remote: employers in the user's country, in remote_countries, or anywhere"),
        remote_countries: z.array(z.string().trim().min(1).max(60)).max(60).optional().describe("Country names, e.g. 'Germany'"),
        relocate: z.boolean().optional().describe("Willing to move"),
        relocate_places: places.describe("Where to"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ profile: asked, levels, ways_of_working, within_km, other_places, remote_for, remote_countries, relocate, relocate_places }) => {
      const codes = remote_countries?.map((country) => ({ country, code: countryCodeFor(country) }));
      const unknown = codes?.filter(({ code }) => !code).map(({ country }) => country) ?? [];
      if (unknown.length > 0) return failure(`Dossier doesn't know ${unknown.join(", ")} as a country. Give each by its name, e.g. 'Netherlands'.`);
      const changes = given({
        modes: ways_of_working?.map((mode) => WAYS_OF_WORKING[mode]),
        radiusKm: within_km,
        otherPlaces: other_places && [...new Set(other_places)],
        remoteOpenTo: remote_for,
        remoteCountries: codes && [...new Set(codes.map(({ code }) => code))],
        relocate,
        relocatePlaces: relocate_places && [...new Set(relocate_places)],
      });
      if (!levels && Object.keys(changes).length === 0) return failure("Give the levels, or what changes about where it wants to work.");
      const chosen = await chooseProfile(asked);
      if ("failure" in chosen) return chosen.failure;

      // Checked whole before anything is saved, as the screen's form is.
      const workplace = Object.keys(changes).length > 0 ? workplaceSchema.safeParse({ ...(await loadProfileWorkplace(chosen.id)).workplace, ...changes }) : null;
      if (workplace && !workplace.success) return failure(workplace.error.issues[0]?.message ?? "That isn't where a profile can want to work.");
      if (levels) await saveProfileLevels(chosen.id, levelRange(levels.from, levels.to)!);
      if (workplace) await saveProfileWorkplace(chosen.id, workplace.data);

      const [profile, range, saved] = await Promise.all([loadProfile(chosen.id), loadProfileLevels(chosen.id), loadProfileWorkplace(chosen.id)]);
      const target = range ? seniorityAndLocation({ data: profile, levels: range, workplace: saved.workplace }) : null;
      return text({
        profile: chosen.name,
        ...(range && target
          ? { jobsItsFor: levelRangeLabel(range), whereItWantsToWork: target.location }
          : { levels_not_set: "Nothing is scored against this profile until its levels are set." }),
        link: sectionLink(chosen.id, "target"),
      });
    },
  );

  const name = text100.min(1);
  server.registerTool(
    "edit_profile_items",
    {
      title: "Edit skills, languages and facts",
      description:
        "Adds and removes skills and languages, changes a language's level, and adds, changes or removes facts about the user, several at once. " +
        "Skills are the profile's own; languages and facts are every profile's. " +
        "Removing a skill also takes it off every role and project, and can't be undone. " +
        "Save only what the user told you or confirmed; never add skills, languages or facts they didn't give.",
      inputSchema: z.object({
        profile: profileInput.describe("The profile whose skills change; the first when left out"),
        add_skills: z.array(name).max(50).optional(),
        remove_skills: z.array(name).max(50).optional().describe("By name"),
        set_languages: z
          .array(z.object({ name, level: z.enum(LanguageLevel) }))
          .max(30)
          .optional()
          .describe("Adds each language, or changes the level of one that's there"),
        remove_languages: z.array(name).max(30).optional().describe("By name"),
        add_facts: z
          .array(z.string().trim().min(1).max(1000))
          .max(50)
          .optional()
          .describe("What the AI should know that the rest of the profile doesn't say, e.g. 'I can start in March.'"),
        change_facts: z
          .array(z.object({ id: z.string().min(1).max(100), text: z.string().trim().min(1).max(1000) }))
          .max(50)
          .optional(),
        remove_facts: z.array(z.string().min(1).max(100)).max(50).optional().describe("By id"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async ({ profile: asked, ...input }) => {
      if (Object.values(input).every((list) => !list?.length)) {
        return failure("Say what to change: add_skills, remove_skills, set_languages, remove_languages, add_facts, change_facts or remove_facts.");
      }
      const chosen = await chooseProfile(asked);
      if ("failure" in chosen) return chosen.failure;
      const skills = { added: [] as string[], already_there: [] as string[], removed: [] as string[], not_found: [] as string[] };
      for (const skillName of input.remove_skills ?? []) {
        const skill = await prisma.skill.findUnique({ where: { profileId_name: { profileId: chosen.id, name: skillName } }, select: { id: true, name: true } });
        if (!skill) {
          skills.not_found.push(skillName);
          continue;
        }
        // The database also detaches it from every role and project (PRO-3).
        await prisma.skill.deleteMany({ where: { id: skill.id } });
        skills.removed.push(skill.name);
      }
      for (const skillName of input.add_skills ?? []) {
        const { skill, added } = await findOrCreateSkill(chosen.id, skillName);
        (added ? skills.added : skills.already_there).push(skill.name);
      }

      const languages = { added: [] as string[], changed: [] as string[], removed: [] as string[], not_found: [] as string[] };
      for (const languageName of input.remove_languages ?? []) {
        const language = await prisma.language.findUnique({ where: { name: languageName }, select: { id: true, name: true } });
        if (!language) {
          languages.not_found.push(languageName);
          continue;
        }
        await prisma.language.deleteMany({ where: { id: language.id } });
        languages.removed.push(language.name);
      }
      for (const { name: languageName, level } of input.set_languages ?? []) {
        const { language, added } = await addOrUpdateLanguage(languageName, level);
        (added ? languages.added : languages.changed).push(language.name);
      }

      // Only the profile's own facts: an application's are its own.
      const facts = {
        added: [] as FactItem[],
        changed: [] as string[],
        removed: [] as string[],
        not_found: [] as string[],
        not_added: undefined as { facts: string[]; because: string } | undefined,
      };
      for (const id of input.remove_facts ?? []) {
        const { count } = await prisma.fact.deleteMany({ where: { id, applicationId: null } });
        (count > 0 ? facts.removed : facts.not_found).push(id);
      }
      for (const { id, text: factText } of input.change_facts ?? []) {
        const { count } = await prisma.fact.updateMany({ where: { id, applicationId: null }, data: { text: factText } });
        (count > 0 ? facts.changed : facts.not_found).push(id);
      }
      const adding = input.add_facts ?? [];
      for (const [index, factText] of adding.entries()) {
        try {
          facts.added.push(await addFact(null, factText));
        } catch (error) {
          if (!(error instanceof ActionError)) throw error;
          facts.not_added = { facts: adding.slice(index), because: error.message };
          break;
        }
      }

      const told = (group: Record<string, unknown>) => {
        const kept = Object.entries(group).filter(([, value]) => (Array.isArray(value) ? value.length > 0 : value !== undefined));
        return kept.length > 0 ? Object.fromEntries(kept) : undefined;
      };
      const onlyFacts = !input.add_skills?.length && !input.remove_skills?.length && !input.set_languages?.length && !input.remove_languages?.length;
      return text({ profile: chosen.name, skills: told(skills), languages: told(languages), facts: told(facts), link: sectionLink(chosen.id, onlyFacts ? "facts" : "skills") });
    },
  );

  server.registerTool(
    "save_profile_entry",
    {
      title: "Add or change a profile entry",
      description:
        "Adds one experience (volunteering too), project, education, certification, publication or reference entry, or an item of a section the user made (section_item), " +
        "or changes the one whose id from get_profile is given, where only the fields given change; answers with the entry as get_profile shows it. " +
        "Dates are 'YYYY-MM' or 'YYYY' ('' clears one), and current means it's still going on; bullets, details and skills replace the entry's lists, and new skills join the profile's. " +
        "Save only what the user told you or confirmed; never add experience, numbers or facts they didn't give.",
      inputSchema: z.object({
        profile: profileInput.describe("The profile the entry is in, or goes into; the first when left out"),
        experience: experienceInput.optional(),
        project: projectInput.optional(),
        education: educationInput.optional(),
        certification: certificationInput.optional(),
        publication: publicationInput.optional(),
        reference: referenceInput.optional(),
        section_item: sectionItemInput.optional().describe("Subtitle, dates and details show only in a section of entries"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ profile: asked, ...input }) => {
      const kinds = ENTRY_KINDS.filter((kind) => input[kind] !== undefined);
      if (kinds.length !== 1) return failure("Give exactly one entry: experience, project, education, certification, publication, reference or section_item.");
      const [kind] = kinds;
      // Which section a new item goes into isn't one of its fields.
      const { id, section_id, ...fields } = { section_id: undefined, ...input[kind]! };
      if (Object.keys(given(fields)).length === 0) return failure(`Give the ${NOUN[kind]}'s fields to save.`);
      const chosen = await chooseProfile(asked);
      if ("failure" in chosen) return chosen.failure;
      if (kind === "section_item" && id === undefined) {
        const inProfile = section_id ? await prisma.customSection.count({ where: { id: section_id, profileId: chosen.id } }) : 0;
        if (!inProfile) return failure("Give the section_id of one of the profile's other_sections from get_profile. The user adds a section on the Profile screen.");
      }
      const saved = await saveEntry(chosen.id, kind, input);
      if (!saved) return noSuchEntry(kind);
      const entry = listedEntry(await loadProfile(chosen.id), kind, saved.id);
      return text({
        profile: chosen.name,
        saved: kind,
        created: id === undefined,
        entry,
        new_skills: saved.newSkills.length > 0 ? saved.newSkills : undefined,
        link: sectionLink(chosen.id, sectionOf(kind, { volunteering: entry?.volunteering === true, sectionId: entry?.section_id as string | undefined })),
      });
    },
  );

  server.registerTool(
    "remove_profile_entry",
    {
      title: "Remove a profile entry",
      description:
        "Removes one experience, project, education, certification, publication, reference or section_item entry by its id from get_profile, or the photo. " +
        "Called again within the hour with restore: true, it puts that one back, as Undo does on the Profile screen.",
      inputSchema: z.object({
        profile: profileInput.describe("The profile the entry is in; the first when left out. A restored entry goes back to the profile it was in"),
        kind: z.enum([...ENTRY_KINDS, "photo"]),
        id: z.string().min(1).max(100).optional().describe("The entry's id from get_profile; not needed for the photo"),
        restore: z.boolean().optional().describe("Puts back one removed with this tool"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ profile: asked, kind, id, restore }) => {
      if (kind !== "photo" && !id) return failure("Give the entry's id from get_profile.");
      const key = kind === "photo" ? kind : `${kind}:${id}`;
      const connection = await connectorSince();
      if (restore) {
        const removed = keptRemoved(key, connection);
        if (!removed) return failure("There's nothing to put back for that. Only what this tool removed in the last hour can be.");
        // The old photo would replace one added since.
        if (removed.kind === "photo" && (await loadPhoto())) {
          return failure("The profile has another photo now, so the removed one can't come back. The user can change the photo on the Profile screen.");
        }
        // An item goes back only into its own section.
        if (removed.kind === "section_item" && !(await prisma.customSection.count({ where: { id: removed.sectionId } }))) {
          return failure("The section that item was in is gone, so it can't come back.");
        }
        await putBack(removed);
        forgetRemoved(key);
        return text({ restored: kind, id, title: removed.title, link: sectionLink(removed.profileId, removedSection(removed)) });
      }

      const chosen = await chooseProfile(asked);
      if ("failure" in chosen) return chosen.failure;
      const profile = await loadProfile(chosen.id);
      if (kind === "photo") {
        if (!profile.photo) return failure("There's no photo in the profile.");
        await deletePhoto();
        keepRemoved(key, { kind, entry: profile.photo, position: 0, title: "The photo", profileId: chosen.id }, connection);
        return text({ removed: kind, undo: "remove_profile_entry with kind photo and restore: true puts it back within the hour.", link: sectionLink(chosen.id, "basics") });
      }
      const found = findEntry(profile, chosen.id, kind, id!);
      if (!found) return noSuchEntry(kind);
      await deleteEntry(chosen.id, kind, id!);
      keepRemoved(key, found, connection);
      return text({
        removed: kind,
        id,
        title: found.title,
        undo: "remove_profile_entry with the same kind and id and restore: true puts it back within the hour.",
        link: sectionLink(chosen.id, removedSection(found)),
      });
    },
  );

  server.registerTool(
    "sort_profile_entries",
    {
      title: "Order profile entries",
      description:
        "Puts experience, projects, education or publications in an order set by hand (ids: every entry's id, in the new order), " +
        "or experience, projects or education back in date order, newest first (by_date), as the Profile screen does.",
      inputSchema: z.object({
        profile: profileInput,
        section: z.enum(["experience", "projects", "education", "publications"]),
        ids: z.array(z.string().min(1).max(100)).max(200).optional().describe("Every entry's id in the section, in the new order"),
        by_date: z.boolean().optional().describe("Back to newest first by start date"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ profile: asked, section, ids, by_date }) => {
      if (Boolean(ids) === Boolean(by_date)) return failure("Give either ids, every entry's id in the new order, or by_date: true.");
      const kind = SORTABLE[section];
      if (by_date && kind === "publication") return failure("Publications have no dates: give their ids in the order you want.");
      const chosen = await chooseProfile(asked);
      if ("failure" in chosen) return chosen.failure;
      try {
        if (kind === "publication") await reorderPublicationList(chosen.id, ids!);
        else if (by_date) await sortSectionByDate(chosen.id, kind);
        else await reorderSection(chosen.id, kind, ids!);
      } catch (error) {
        if (!(error instanceof ActionError)) throw error;
        return failure("Give the id of every entry in that section once, in the new order. get_profile lists them.");
      }
      const entries = titles(await loadProfile(chosen.id), kind).map((entry) => entry.title);
      return text({ profile: chosen.name, section, order: by_date ? "by date" : "by hand", entries, link: sectionLink(chosen.id, section) });
    },
  );

  server.registerTool(
    "import_profile_from_resume",
    {
      title: "Import the profile from a resume",
      description:
        "Has Dossier's own AI model read a pasted resume into a profile, as the Import screen does; nothing goes into the profile yet, and an earlier reading is set aside. " +
        "The text, contact details included, goes to the AI provider set in Dossier, so tell the user first; without a provider, fill in the profile yourself with the other profile tools. " +
        "Follow it with check_task, then finish_profile_import.",
      inputSchema: z.object({ resume_text: z.string().trim().min(1).max(100_000).describe("The resume's whole text") }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ resume_text }) => {
      if (!(await isAiUsable())) {
        return failure(
          "Dossier has no AI model of its own set up to read the resume. Read it yourself and fill in the profile with update_profile_basics, edit_profile_items and save_profile_entry.",
        );
      }
      const read = await resumeText(new TextEncoder().encode(resume_text));
      if (!read.ok) return failure(read.error === RESUME_MESSAGES.tooShort ? "There's hardly any text in that resume. Paste all of it." : read.error);
      // Who reads it, named as on the Import screen, so Claude can tell the user where the text went.
      const reader = providerOption((await loadAiConfig()).provider);
      // Only one resume's text is kept: earlier readings go first, as on the Import screen.
      await discardProfileImports();
      const taskId = await startJob(importProfileJob, { resume: read.text }, { key: "profile-import" });
      return started(taskId, {
        sent_to: reader.vendor ?? (reader.local ? "your own AI server" : "your AI server"),
        link: linkTo(`/profile/import?job=${taskId}`),
        then: "Once it's done, show the user what was read with finish_profile_import.",
      });
    },
  );

  server.registerTool(
    "finish_profile_import",
    {
      title: "Finish importing a resume",
      description:
        "Shows what a resume reading found (choice show), then does what the user chose: merge adds it to the profile, and the resume wins where both say something; " +
        "replace clears the profile's own headline, summary, skills, roles, projects, education, certifications, publications and references first, and keeps what every profile shares; discard sets it aside. " +
        "Only merge or replace once the user has seen it and said so.",
      inputSchema: z.object({
        task_id: z.string().min(1).max(100).optional().describe("From import_profile_from_resume; leave it out for the latest reading, also one from the Import screen"),
        choice: z.enum(["show", "merge", "replace", "discard"]).default("show"),
        profile: profileInput.describe("The profile it goes into on merge or replace; the first when left out"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async ({ task_id, choice, profile: asked }) => {
      const job = await prisma.job.findFirst({
        where: { type: importProfileJob.type, ...(task_id ? { id: task_id } : {}) },
        orderBy: { createdAt: "desc" },
        select: { id: true, status: true, step: true, error: true, result: true },
      });
      if (!job) return failure("There's no resume reading waiting. Start one with import_profile_from_resume.");
      if (choice === "discard") {
        // "Choose another file": the reading goes, with the resume's text, and stops if it's under way.
        await discardProfileImports(job.id);
        return text({ task_id: job.id, discarded: true, link: linkTo("/profile/import") });
      }
      if (job.status === JobStatus.FAILED) return failure(`${job.error ?? "The resume couldn't be read."} Start again with import_profile_from_resume.`);
      if (job.status !== JobStatus.DONE) {
        if (choice !== "show") return failure("The resume is still being read. Wait until check_task says it's done.");
        return text({ task_id: job.id, status: "working", step: job.step ?? "Starting", next: "Call check_task with this task_id until it's done." });
      }
      const reading = importProfileJob.result.safeParse(job.result);
      if (!reading.success) return failure("That reading can't be used. Start again with import_profile_from_resume.");
      const { profile } = reading.data;
      if (choice === "show") {
        return text({
          task_id: job.id,
          found: importCounts(profile),
          read: importView(profile),
          next: "Show the user, and ask about anything in check: it isn't in the resume word for word. Then call this again with merge, replace or discard, as they choose.",
          link: linkTo(`/profile/import?job=${job.id}`),
        });
      }
      const chosen = await chooseProfile(asked);
      if ("failure" in chosen) return chosen.failure;
      try {
        await applyProfileImportJob(job.id, chosen.id, choice as ImportMode);
      } catch (error) {
        if (!(error instanceof ActionError)) throw error;
        return failure("That reading is no longer there. Start again with import_profile_from_resume.");
      }
      return text({
        task_id: job.id,
        profile: chosen.name,
        done: `${choice === "replace" ? "The profile now holds" : "Added to the profile"}: ${importCounts(profile)}.`,
        link: linkTo(`/profile?profile=${chosen.id}`),
      });
    },
  );
}
