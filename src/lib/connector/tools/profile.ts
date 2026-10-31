import "server-only";

import { z } from "zod";

import { JobStatus, LanguageLevel } from "@/generated/prisma/enums";
import { ActionError } from "@/lib/action";
import { isAiUsable, loadAiConfig } from "@/lib/ai/config";
import { providerOption } from "@/lib/ai/provider-options";
import { citationText } from "@/lib/citation";
import { addFact } from "@/lib/facts";
import { applyProfileImportJob, discardProfileImports, importProfileJob } from "@/lib/jobs/import-profile";
import { startJob } from "@/lib/jobs/runner";
import { PHOTO_KEY, PHOTO_ON_RESUMES_KEY, photoFromFields } from "@/lib/photo";
import { prisma } from "@/lib/prisma";
import {
  basicsFromFields,
  BASICS_FIELDS,
  PROFILE_KEYS,
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
  newEducation,
  newExperience,
  newProject,
  newPublication,
  newReference,
  ORDER_SETTING,
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
import { findOrCreateSkill } from "@/lib/profile-entries";
import { importCounts, type ImportedProfile } from "@/lib/profile-import";
import { RESUME_MESSAGES, resumeText } from "@/lib/resume-text";
import { loadSettings } from "@/lib/settings-data";

import { failure, started, text, type ToolContext } from "../kit";
import { connectorSince } from "../oauth";
import { forgetRemoved, keepRemoved, keptRemoved, type Removed } from "../removed-entries";

// The profile: reading it, and editing it as the Profile and Import screens
// do (jobauto fork). Contact details go in but don't come out: Claude reads
// which are filled in, never their values, and a reference's email and phone
// stay in Dossier the same way. Links are left out like on the AI's prompts.

/** The entries save_profile_entry and remove_profile_entry work on. */
const ENTRY_KINDS = ["experience", "project", "education", "publication", "reference"] as const;
type EntryKind = (typeof ENTRY_KINDS)[number];

/** Each kind's section on the Profile screen (?section=), and its list in get_profile. */
const SECTION = { experience: "experience", project: "projects", education: "education", publication: "publications", reference: "references" } as const;

/** What each kind is called in answers. */
const NOUN: Record<EntryKind, string> = { experience: "role", project: "project", education: "education entry", publication: "publication", reference: "reference" };

const filled = (value: string | undefined) => Boolean(value?.trim());

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
    address: filled(basics.address),
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
    publications: profile.publications.map((entry) => ({ id: entry.id, citation: entry.citation, has_link: filled(entry.link), on_resumes: entry.onResumes })),
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
    case "publication":
      return profile.publications.map((entry) => {
        const citation = citationText(entry.citation);
        return { id: entry.id, title: (citation.length > 80 ? `${citation.slice(0, 79)}…` : citation) || "New publication" };
      });
    case "reference":
      return profile.references.map((entry) => ({ id: entry.id, title: entry.name.trim() || "New reference" }));
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
    publications: profile.publications.map((entry) => ({ citation: entry.citation, has_link: filled(entry.link), check: check(entry.unverified) })),
    references: profile.references.map((entry) => ({
      name: entry.name,
      relation: entry.relation,
      company: entry.company,
      has_email: filled(entry.email),
      has_phone: filled(entry.phone),
      check: check(entry.unverified),
    })),
  };
}

// ─── Undo for remove_profile_entry ───────────────────────────────────────────
// What it takes out stays in the server's memory for an hour
// (../removed-entries.ts), so a reference's email and phone never reach Claude.

/** The entry with that id and its place, as remove_profile_entry keeps it; null when there's none. */
function findEntry(profile: ProfileData, kind: EntryKind, id: string): Removed | null {
  const listed = titles(profile, kind);
  const position = listed.findIndex((entry) => entry.id === id);
  if (position < 0) return null;
  const { title } = listed[position];
  switch (kind) {
    case "experience":
      return { kind, entry: profile.experience[position], position, title };
    case "project":
      return { kind, entry: profile.projects[position], position, title };
    case "education":
      return { kind, entry: profile.education[position], position, title };
    case "publication":
      return { kind, entry: profile.publications[position], position, title };
    case "reference":
      return { kind, entry: profile.references[position], position, title };
  }
}

/** Removes an entry, as the screen's Remove does. */
async function deleteEntry(kind: EntryKind, id: string): Promise<void> {
  if (kind === "experience") await prisma.experience.deleteMany({ where: { id } });
  else if (kind === "project") await prisma.project.deleteMany({ where: { id } });
  else if (kind === "education") await prisma.education.deleteMany({ where: { id } });
  else if (kind === "publication") await prisma.publication.deleteMany({ where: { id } });
  else await prisma.reference.deleteMany({ where: { id } });
}

/** Back in its place where the order is set by hand, as the screen's Undo does; in date order, its dates place it. References keep no order. */
async function backInPlace(kind: Exclude<EntryKind, "reference">, id: string, position: number): Promise<void> {
  if (kind !== "publication" && (await loadSettings())[ORDER_SETTING[kind]] !== "manual") return;
  const ids = titles(await loadProfile(), kind)
    .map((entry) => entry.id)
    .filter((entryId) => entryId !== id);
  ids.splice(Math.min(position, ids.length), 0, id);
  if (kind === "publication") await reorderPublicationList(ids);
  else await reorderSection(kind, ids);
}

/** Puts back what remove_profile_entry took out. */
async function putBack(removed: Removed): Promise<void> {
  switch (removed.kind) {
    case "experience":
      await restoreExperienceEntry(removed.entry);
      return backInPlace(removed.kind, removed.entry.id, removed.position);
    case "project":
      await restoreProjectEntry(removed.entry);
      return backInPlace(removed.kind, removed.entry.id, removed.position);
    case "education":
      await restoreEducationEntry(removed.entry);
      return backInPlace(removed.kind, removed.entry.id, removed.position);
    case "publication":
      await restorePublicationEntry(removed.entry);
      return backInPlace(removed.kind, removed.entry.id, removed.position);
    case "reference":
      await restoreReferenceEntry(removed.entry);
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

const lines = (bullets: string[] | undefined) => (bullets === undefined ? {} : { bullets: bullets.filter(Boolean).join("\n") });

/** Sets the skills used in a role or project, by name, adding the ones the profile doesn't have yet (PRO-6); answers with those. */
async function setSkillsUsed(kind: "experience" | "project", id: string, names: string[]): Promise<string[]> {
  const found = [];
  for (const name of names) found.push(await findOrCreateSkill(name));
  const skillIds = [...new Set(found.map(({ skill }) => skill.id))];
  if (kind === "experience") {
    await prisma.$transaction([
      prisma.experienceSkill.deleteMany({ where: { experienceId: id, skillId: { notIn: skillIds } } }),
      prisma.experienceSkill.createMany({ data: skillIds.map((skillId) => ({ experienceId: id, skillId })), skipDuplicates: true }),
    ]);
  } else {
    await prisma.$transaction([
      prisma.projectSkill.deleteMany({ where: { projectId: id, skillId: { notIn: skillIds } } }),
      prisma.projectSkill.createMany({ data: skillIds.map((skillId) => ({ projectId: id, skillId })), skipDuplicates: true }),
    ]);
  }
  return found.filter(({ added }) => added).map(({ skill }) => skill.name);
}

type EntryInput = {
  experience?: z.output<typeof experienceInput>;
  project?: z.output<typeof projectInput>;
  education?: z.output<typeof educationInput>;
  publication?: z.output<typeof publicationInput>;
  reference?: z.output<typeof referenceInput>;
};

/**
 * Saves one entry as the screen's "+ Add" and autosave do: a new one is
 * placed like one added there, then gets its fields. Answers with its id and
 * the skills that joined the profile, or null when the id is no longer there.
 */
async function saveEntry(kind: EntryKind, input: EntryInput): Promise<{ id: string; newSkills: string[] } | null> {
  if (kind === "experience" && input.experience) {
    const { id, skills, bullets, start, end, current, ...fields } = input.experience;
    const entryId = id ?? (await newExperience()).id;
    const data = { ...given(fields), ...lines(bullets), ...spanColumns({ start, end, current }) };
    if ((await prisma.experience.updateMany({ where: { id: entryId }, data })).count === 0) return null;
    return { id: entryId, newSkills: skills ? await setSkillsUsed(kind, entryId, skills) : [] };
  }
  if (kind === "project" && input.project) {
    const { id, skills, bullets, start, end, current, ...fields } = input.project;
    const entryId = id ?? (await newProject()).id;
    const data = { ...given(fields), ...lines(bullets), ...spanColumns({ start, end, current }) };
    if ((await prisma.project.updateMany({ where: { id: entryId }, data })).count === 0) return null;
    return { id: entryId, newSkills: skills ? await setSkillsUsed(kind, entryId, skills) : [] };
  }
  if (kind === "education" && input.education) {
    const { id, start, end, current, ...fields } = input.education;
    const entryId = id ?? (await newEducation()).id;
    const data = { ...given(fields), ...spanColumns({ start, end, current }) };
    return (await prisma.education.updateMany({ where: { id: entryId }, data })).count === 0 ? null : { id: entryId, newSkills: [] };
  }
  if (kind === "publication" && input.publication) {
    const { id, on_resumes, ...fields } = input.publication;
    const entryId = id ?? (await newPublication()).id;
    const data = { ...given(fields), ...(on_resumes === undefined ? {} : { onResumes: on_resumes }) };
    return (await prisma.publication.updateMany({ where: { id: entryId }, data })).count === 0 ? null : { id: entryId, newSkills: [] };
  }
  if (kind === "reference" && input.reference) {
    const { id, ...fields } = input.reference;
    const entryId = id ?? (await newReference()).id;
    return (await prisma.reference.updateMany({ where: { id: entryId }, data: given(fields) })).count === 0 ? null : { id: entryId, newSkills: [] };
  }
  return null;
}

/** For an id that isn't in the profile. */
const noSuchEntry = (kind: EntryKind) => failure(`There's no such ${NOUN[kind]} in the profile. get_profile lists them with their ids.`);

// ─── Sorting ─────────────────────────────────────────────────────────────────

const SORTABLE = { experience: "experience", projects: "project", education: "education", publications: "publication" } as const;

// ─── The tools ───────────────────────────────────────────────────────────────

/** Registers these tools on the connector's server. */
export function registerProfileTools({ server, linkTo }: ToolContext): void {
  const sectionLink = (section: string) => linkTo(`/profile?section=${section}`);

  server.registerTool(
    "get_profile",
    {
      title: "Read the profile",
      description:
        "The user's profile in Dossier, with the ids save_application and the profile tools use: headline, summary, facts about them, skills, languages, experience, projects, education, publications and references. " +
        "Contact details, links and references' email and phone are left out; contact_details says which of the user's own are filled in.",
      annotations: { readOnlyHint: true },
    },
    async () => text({ ...profileView(await loadProfile()), link: linkTo("/profile") }),
  );

  server.registerTool(
    "update_profile_basics",
    {
      title: "Change the profile's basics",
      description:
        "Changes the profile's name, headline, summary and contact details, and whether resumes show the age and the photo. " +
        "Only the fields given change ('' clears one); answers with the fields that changed, without their values. " +
        "Save only what the user told you or confirmed; never add experience, numbers or facts they didn't give.",
      inputSchema: z.object({
        name: z.string().trim().max(200).optional(),
        headline: z.string().trim().max(300).optional().describe("e.g. 'Senior Product Designer'"),
        summary: z.string().trim().max(5000).optional().describe("A few lines about the user"),
        email: z.string().trim().max(320).optional(),
        phone: z.string().trim().max(60).optional(),
        address: z.string().trim().max(300).optional().describe("The street address"),
        city: z.string().trim().max(120).optional(),
        country: z.string().trim().max(120).optional(),
        website: z.string().trim().max(500).optional(),
        linkedin: z.string().trim().max(500).optional().describe("e.g. 'linkedin.com/in/janedoe'"),
        date_of_birth: z.union([z.literal(""), z.iso.date()]).optional().describe("YYYY-MM-DD"),
        show_age: z.boolean().optional().describe("Show the age, from the date of birth, on resumes"),
        photo_on_resumes: z.boolean().optional().describe("Show the photo on resumes; it stays in the profile either way"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ date_of_birth, show_age, photo_on_resumes, ...fields }) => {
      const changes: Partial<Basics> = {
        ...given(fields),
        ...(date_of_birth === undefined ? {} : { dob: date_of_birth }),
        ...(show_age === undefined ? {} : { showAge: show_age }),
      };
      if (Object.keys(changes).length === 0 && photo_on_resumes === undefined) return failure("Give at least one field to change.");
      const photo = photo_on_resumes === undefined ? null : await loadPhoto();
      if (photo_on_resumes !== undefined && !photo) return failure("There's no photo in the profile. The user can add one on the Profile screen.");

      const before = basicsFromFields(await prisma.profileField.findMany({ where: { key: { in: [...PROFILE_KEYS] } } }));
      const after: Basics = { ...before, ...changes };
      const changed: string[] = BASICS_FIELDS.filter((field) => after[field] !== before[field]).map((field) => (field === "dob" ? "date_of_birth" : field));
      if (after.showAge !== before.showAge) changed.push("show_age");
      if (changed.length > 0) await saveBasicsFields(after);
      if (photo && photo_on_resumes !== undefined && photo.onResumes !== photo_on_resumes) {
        await photoOnResumesRow(photo_on_resumes);
        changed.push("photo_on_resumes");
      }
      return text({ changed, link: sectionLink("basics") });
    },
  );

  const name = text100.min(1);
  server.registerTool(
    "edit_profile_items",
    {
      title: "Edit skills, languages and facts",
      description:
        "Adds and removes skills and languages, changes a language's level, and adds, changes or removes facts about the user, several at once. " +
        "Removing a skill also takes it off every role and project, and can't be undone. " +
        "Save only what the user told you or confirmed; never add skills, languages or facts they didn't give.",
      inputSchema: z.object({
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
    async (input) => {
      if (Object.values(input).every((list) => !list?.length)) {
        return failure("Say what to change: add_skills, remove_skills, set_languages, remove_languages, add_facts, change_facts or remove_facts.");
      }
      const skills = { added: [] as string[], already_there: [] as string[], removed: [] as string[], not_found: [] as string[] };
      for (const skillName of input.remove_skills ?? []) {
        const skill = await prisma.skill.findUnique({ where: { name: skillName }, select: { id: true, name: true } });
        if (!skill) {
          skills.not_found.push(skillName);
          continue;
        }
        // The database also detaches it from every role and project (PRO-3).
        await prisma.skill.deleteMany({ where: { id: skill.id } });
        skills.removed.push(skill.name);
      }
      for (const skillName of input.add_skills ?? []) {
        const { skill, added } = await findOrCreateSkill(skillName);
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
      return text({ skills: told(skills), languages: told(languages), facts: told(facts), link: sectionLink(onlyFacts ? "facts" : "skills") });
    },
  );

  server.registerTool(
    "save_profile_entry",
    {
      title: "Add or change a profile entry",
      description:
        "Adds one experience, project, education, publication or reference entry, or changes the one whose id from get_profile is given, where only the fields given change; answers with the entry as get_profile shows it. " +
        "Dates are 'YYYY-MM' or 'YYYY' ('' clears one), and current means it's still going on; bullets and skills replace the entry's lists, and new skills join the profile's. " +
        "Save only what the user told you or confirmed; never add experience, numbers or facts they didn't give.",
      inputSchema: z.object({
        experience: experienceInput.optional(),
        project: projectInput.optional(),
        education: educationInput.optional(),
        publication: publicationInput.optional(),
        reference: referenceInput.optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (input) => {
      const kinds = ENTRY_KINDS.filter((kind) => input[kind] !== undefined);
      if (kinds.length !== 1) return failure("Give exactly one entry: experience, project, education, publication or reference.");
      const [kind] = kinds;
      const { id, ...fields } = input[kind]!;
      if (Object.keys(given(fields)).length === 0) return failure(`Give the ${NOUN[kind]}'s fields to save.`);
      const saved = await saveEntry(kind, input);
      if (!saved) return noSuchEntry(kind);
      const listed: { id: string }[] = profileView(await loadProfile())[SECTION[kind]];
      const entry = listed.find((item) => item.id === saved.id);
      return text({
        saved: kind,
        created: id === undefined,
        entry,
        new_skills: saved.newSkills.length > 0 ? saved.newSkills : undefined,
        link: sectionLink(SECTION[kind]),
      });
    },
  );

  server.registerTool(
    "remove_profile_entry",
    {
      title: "Remove a profile entry",
      description:
        "Removes one experience, project, education, publication or reference entry by its id from get_profile, or the photo. " +
        "Called again within the hour with restore: true, it puts that one back, as Undo does on the Profile screen.",
      inputSchema: z.object({
        kind: z.enum([...ENTRY_KINDS, "photo"]),
        id: z.string().min(1).max(100).optional().describe("The entry's id from get_profile; not needed for the photo"),
        restore: z.boolean().optional().describe("Puts back one removed with this tool"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ kind, id, restore }) => {
      if (kind !== "photo" && !id) return failure("Give the entry's id from get_profile.");
      const key = kind === "photo" ? kind : `${kind}:${id}`;
      const link = sectionLink(kind === "photo" ? "basics" : SECTION[kind]);
      const connection = await connectorSince();
      if (restore) {
        const removed = keptRemoved(key, connection);
        if (!removed) return failure("There's nothing to put back for that. Only what this tool removed in the last hour can be.");
        // The old photo would replace one added since.
        if (removed.kind === "photo" && (await loadPhoto())) {
          return failure("The profile has another photo now, so the removed one can't come back. The user can change the photo on the Profile screen.");
        }
        await putBack(removed);
        forgetRemoved(key);
        return text({ restored: kind, id, title: removed.title, link });
      }

      const profile = await loadProfile();
      if (kind === "photo") {
        if (!profile.photo) return failure("There's no photo in the profile.");
        await deletePhoto();
        keepRemoved(key, { kind, entry: profile.photo, position: 0, title: "The photo" }, connection);
        return text({ removed: kind, undo: "remove_profile_entry with kind photo and restore: true puts it back within the hour.", link });
      }
      const found = findEntry(profile, kind, id!);
      if (!found) return noSuchEntry(kind);
      await deleteEntry(kind, id!);
      keepRemoved(key, found, connection);
      return text({ removed: kind, id, title: found.title, undo: "remove_profile_entry with the same kind and id and restore: true puts it back within the hour.", link });
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
        section: z.enum(["experience", "projects", "education", "publications"]),
        ids: z.array(z.string().min(1).max(100)).max(200).optional().describe("Every entry's id in the section, in the new order"),
        by_date: z.boolean().optional().describe("Back to newest first by start date"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ section, ids, by_date }) => {
      if (Boolean(ids) === Boolean(by_date)) return failure("Give either ids, every entry's id in the new order, or by_date: true.");
      const kind = SORTABLE[section];
      if (by_date && kind === "publication") return failure("Publications have no dates: give their ids in the order you want.");
      try {
        if (kind === "publication") await reorderPublicationList(ids!);
        else if (by_date) await sortSectionByDate(kind);
        else await reorderSection(kind, ids!);
      } catch (error) {
        if (!(error instanceof ActionError)) throw error;
        return failure("Give the id of every entry in that section once, in the new order. get_profile lists them.");
      }
      const entries = titles(await loadProfile(), kind).map((entry) => entry.title);
      return text({ section, order: by_date ? "by date" : "by hand", entries, link: sectionLink(section) });
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
        "replace clears the basics, skills, languages, roles, projects, education, publications and references first; discard sets it aside. Only merge or replace once the user has seen it and said so.",
      inputSchema: z.object({
        task_id: z.string().min(1).max(100).optional().describe("From import_profile_from_resume; leave it out for the latest reading, also one from the Import screen"),
        choice: z.enum(["show", "merge", "replace", "discard"]).default("show"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async ({ task_id, choice }) => {
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
      try {
        await applyProfileImportJob(job.id, choice);
      } catch (error) {
        if (!(error instanceof ActionError)) throw error;
        return failure("That reading is no longer there. Start again with import_profile_from_resume.");
      }
      return text({ task_id: job.id, done: `${choice === "replace" ? "The profile now holds" : "Added to the profile"}: ${importCounts(profile)}.`, link: linkTo("/profile") });
    },
  );
}
