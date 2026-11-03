import "server-only";

import { DocumentKind } from "@/generated/prisma/enums";
import { sameSkill } from "@/lib/ai/tasks/match-requirements";
import { extractedSchema, matchSchema, unitsSchema, type Extracted, type Match, type Unit } from "@/lib/application-data";
import { readJson } from "@/lib/application-documents";
import { documentLabels, ENGLISH_LABELS, type DocumentLabels } from "@/lib/document-labels";
import { detectLanguageName, knownLanguage } from "@/lib/document-language";
import { updateDocuments } from "@/lib/document-units";
import { countryCodeFor, countryName } from "@/lib/job-search/countries";
import { normalText } from "@/lib/job-search/search";
import { renderDocumentPdf } from "@/lib/pdf/documents";
import { countPdfPages } from "@/lib/pdf/pages";
import { prisma } from "@/lib/prisma";
import { sameName, type ProfileData } from "@/lib/profile";
import { loadProfile } from "@/lib/profile-data";
import { resumeContent, type ResumeContent } from "@/lib/resume-content";
import { maxPages, type SettingsData } from "@/lib/settings";
import { loadSettings } from "@/lib/settings-data";
import { countriesNamed, DACH, placeOf, reach } from "@/lib/startups/place";
import { loadTheme, THEME_FIELDS } from "@/lib/theme-data";
import { BUILT_IN_THEMES, hasSidebar } from "@/lib/themes";
import { isBulletUnit, isPublicationUnit, plainText } from "@/lib/unit-text";

// The ATS check of a resume PDF: whether an applicant-tracking system's
// parser would read it as the page shows it. The resume is printed as
// Download PDF prints it and read back the way a parser reads it, from the
// text layer; then what came back is compared with what the page meant to
// print. The application's Resume tab, the Base resume screen and the Claude
// connector's check_resume all ask here. The report names things by their
// labels and counts only: never a line of the document, never an email or
// a phone number, so it can go to Claude and into a screen reader alike.

export type CheckLevel = "ok" | "warn" | "fail";

/** What a screen can offer to do about an item, each the switch or setting that puts it right. */
export type CheckFix =
  | { kind: "single-column" }
  | { kind: "theme" }
  | { kind: "photo" }
  | { kind: "language"; language: string }
  | { kind: "add-skill"; skill: string }
  | { kind: "mention"; term: string }
  | { kind: "settings"; section: "documents" }
  | { kind: "clean-up" };

export type CheckItem = { id: string; level: CheckLevel; title: string; detail?: string; fix?: CheckFix };

/** One requirement of the posting: whether the resume names it, and how the profile spells it. The job title has index -1. */
export type RequirementCheck = { index: number; requirement: string; named: boolean; inProfile: boolean; skill: string | null };

export type ResumeCheck = {
  document: "base" | "resume";
  fileName: string;
  pages: number;
  maxPages: number | null;
  /** Whether a parser gets the text: the text layer, contact details, columns, headings, pages, file name and photo. */
  reads: CheckItem[];
  /** The posting's requirements, for a tailored resume with some; null for the base resume. The counts leave the job title out. */
  requirements: { items: RequirementCheck[]; named: number; total: number } | null;
  /** Clean text: characters, language and dates. */
  text: CheckItem[];
  /** When the check ran, as an ISO time. */
  checkedAt: string;
};

const GONE = "That application no longer exists.";
const NO_RESUME = "This application has no tailored resume.";

/** Characters that print as nothing: a parser splits a word on them, and so would a comparison. */
const INVISIBLE = /[​⁠﻿­]/g;

/** What the clean-up (plainText) puts right: ligature glyphs, the odd hyphens and the invisible characters. */
const FIXABLE = /[\uFB00-\uFB06\u2010\u2011\u200B\u2060\uFEFF\u00AD]/;

/** Scripts written without spaces between words (Chinese, Japanese, Thai…): a line can wrap inside what folding takes for one word. */
const UNSPACED = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;

/** How many of a bullet's words must read back: enough to tell it apart, few enough to survive a line wrap. */
const BULLET_WORDS = 6;

/** The same for a bullet in a script without spaces, in characters. */
const BULLET_CHARACTERS = 12;

/** Text as words for comparing: no invisible characters, accents, case or punctuation, one space between words. */
const fold = (text: string) => normalText(text.replace(INVISIBLE, ""));

/** Whether `needle` is in `haystack` as whole words, both folded. */
const hasWords = (haystack: string, needle: string) => ` ${haystack} `.includes(` ${needle} `);

/** A word without its plural "s", as sameSkill forgives it: "systems" names "system". */
const singular = (word: string) => (word.length > 3 && word.endsWith("s") ? word.slice(0, -1) : word);

/** A text's words, folded and in the singular. */
const tokensOf = (text: string) => fold(text).split(" ").filter(Boolean).map(singular);

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

type Inputs = {
  document: "base" | "resume";
  profile: ProfileData;
  settings: SettingsData;
  /** Whether the printed layout has a sidebar: a tailored resume's folds into one column unless it follows the theme's (APP-4). */
  split: boolean;
  /** The document's language by name; "" for an application without one recorded. */
  language: string;
  /** A tailored resume's parts; the base resume prints the profile. */
  units?: Unit[];
  includeReferences: boolean;
  /** The application's Photo switch (#224); null or absent follows the profile. */
  showPhoto?: boolean | null;
  /** The posting's location and work mode, for the photo note; "" for the base resume. */
  place: string;
  /** The tailored resume's posting, for the requirements; null for the base resume. */
  posting: { role: string; extracted: Extracted | null; match: Match | null } | null;
};

/**
 * What the check needs, loaded the way the print pages load it, or why
 * there's nothing to check. Not loadDocuments(): its notFound() is for
 * pages, and the connector asks here too.
 */
async function loadInputs(doc: "base" | "resume", applicationId: string): Promise<Inputs | { error: string }> {
  const [profile, settings] = await Promise.all([loadProfile(), loadSettings()]);
  const baseTheme = (await loadTheme(settings.baseThemeId)) ?? BUILT_IN_THEMES[0];
  if (doc === "base") {
    return {
      document: "base",
      profile,
      settings,
      split: hasSidebar(baseTheme.layout),
      language: settings.resumeLanguage ?? "English",
      includeReferences: settings.includeRefs,
      place: "",
      posting: null,
    };
  }
  const application = await prisma.application.findUnique({
    where: { id: applicationId },
    select: {
      id: true,
      role: true,
      location: true,
      mode: true,
      language: true,
      extracted: true,
      match: true,
      followThemeLayout: true,
      showPhoto: true,
      documents: { where: { kind: DocumentKind.RESUME }, select: { units: true, theme: { select: THEME_FIELDS } } },
    },
  });
  if (!application) return { error: GONE };
  const row = application.documents[0];
  const units = row && readJson(unitsSchema, row.units);
  if (!row || !units) return { error: NO_RESUME };
  const theme = row.theme ?? baseTheme;
  const extracted = readJson(extractedSchema, application.extracted);
  return {
    document: "resume",
    profile,
    settings,
    split: application.followThemeLayout && hasSidebar(theme.layout),
    language: application.language,
    units,
    includeReferences: settings.includeRefs && extracted?.asksForReferences === true,
    showPhoto: application.showPhoto,
    place: [application.location, application.mode].join(" "),
    posting: { role: application.role.trim() || extracted?.role?.trim() || "", extracted, match: readJson(matchSchema, application.match) },
  };
}

/** The resume's PDF, checked. An application that's gone, or has no tailored resume, is an error written for the user. */
export async function checkResume(doc: "base" | "resume", applicationId = ""): Promise<ResumeCheck | { error: string }> {
  const inputs = await loadInputs(doc, applicationId);
  if ("error" in inputs) return inputs;
  const rendered = await renderDocumentPdf(doc, applicationId);
  if ("error" in rendered) return rendered;

  // Counted before pdf.js reads the bytes: it takes the buffer with it and leaves an empty one behind.
  const pages = countPdfPages(rendered.pdf);
  const { extractText, getDocumentProxy } = await import("unpdf");
  const read = await extractText(await getDocumentProxy(new Uint8Array(rendered.pdf)), { mergePages: true });
  const raw = read.text;

  const labels = documentLabels(inputs.language);
  const content = resumeContent(inputs.profile, { units: inputs.units, includeReferences: inputs.includeReferences, showPhoto: inputs.showPhoto }, labels);
  const headings = printedHeadings(content, labels, inputs.split);
  const limit = maxPages(inputs.settings.pageLimit);
  const photo = photoItem(inputs, content);

  return {
    document: inputs.document,
    fileName: rendered.fileName,
    pages: pages || read.totalPages,
    maxPages: limit,
    reads: [
      textLayerItem(expectedTexts(content, headings), fold(raw)),
      contactItem(inputs.profile, raw),
      columnsItem(inputs),
      headingsItem(inputs, headings, labels),
      pagesItem(pages || read.totalPages, limit),
      fileNameItem(rendered.fileName, inputs.profile),
      ...(photo ? [photo] : []),
    ],
    requirements: inputs.posting ? requirementChecks(inputs.posting, inputs.profile, raw, headings) : null,
    text: [
      charactersItem(raw, inputs),
      ...(inputs.units ? [languageItem(inputs.language, inputs.units)] : []),
      datesItem(raw, labels),
    ],
    checkedAt: new Date().toISOString(),
  };
}

/** The section headings the resume prints (src/components/documents/resume-document.tsx), main column first. */
function printedHeadings(content: ResumeContent, labels: DocumentLabels, split: boolean): string[] {
  const headings = [
    content.summary && labels.profile,
    content.experience.length > 0 && labels.experience,
    content.projects.length > 0 && labels.projects,
    content.education.length > 0 && labels.education,
    content.publications.length > 0 && labels.publications,
    content.references.length > 0 && labels.references,
    split && content.contacts.length > 0 && labels.contact,
    content.skills && labels.skills,
    content.languages && labels.languages,
  ];
  return headings.filter((heading): heading is string => typeof heading === "string" && heading !== "");
}

type Expected = {
  /** How the report names it: "the Experience heading", "bullet 2 of the Northwind Logistics role". */
  label: string;
  text: string;
  /**
   * Compared without spaces: a heading, whose small caps print letter-spaced and can read back with a space after
   * every letter, or text in a script without spaces, where a line wrap splits what folding took for one word.
   */
  loose?: boolean;
};

/** What the text layer must hold, each named for the report: the headings, every title and the start of every bullet. */
function expectedTexts(content: ResumeContent, headings: string[]): Expected[] {
  const start = (bullet: string) =>
    UNSPACED.test(bullet) ? fold(bullet).replace(/ /g, "").slice(0, BULLET_CHARACTERS) : fold(bullet).split(" ").slice(0, BULLET_WORDS).join(" ");
  const entry = (name: string, title: string, bullets: string[]): Expected[] => [
    { label: `the title of the ${name}`, text: title },
    ...bullets.map((bullet, index) => ({ label: `bullet ${index + 1} of the ${name}`, text: start(bullet) })),
  ];
  return [
    { label: "your name", text: content.name },
    { label: "the headline", text: content.headline },
    ...headings.map((heading) => ({ label: `the ${heading} heading`, text: heading, loose: true })),
    ...content.experience.flatMap((role) => entry(`${role.company || role.role} role`, role.role, role.bullets)),
    ...content.projects.flatMap((project) => entry(`${project.name} project`, project.name, project.bullets)),
    ...content.education.map((entry) => ({ label: `the ${entry.degree || entry.school} entry`, text: entry.degree || entry.school })),
  ]
    .filter((expected) => fold(expected.text) !== "")
    .map((expected) => (UNSPACED.test(expected.text) ? { ...expected, loose: true } : expected));
}

function textLayerItem(expected: Expected[], folded: string): CheckItem {
  const tight = folded.replace(/ /g, "");
  const found = ({ text, loose }: Expected) => hasWords(folded, fold(text)) || (loose === true && tight.includes(fold(text).replace(/ /g, "")));
  const missing = expected.find((item) => !found(item));
  if (missing) {
    return {
      id: "text-layer",
      level: "fail",
      title: "Text a parser can't find",
      detail: `The PDF's text layer is missing ${missing.label}. A parser reads that layer, not the picture of the page.`,
    };
  }
  return { id: "text-layer", level: "ok", title: "Text reads as text", detail: `Every heading, title and bullet is in the PDF's text layer (${expected.length} checked).` };
}

/** Email and phone number as text: said to be there or not, never quoted. */
function contactItem(profile: ProfileData, raw: string): CheckItem {
  const squeezed = raw.toLowerCase().replace(/\s+/g, "");
  const email = profile.basics.email.trim().toLowerCase().replace(/\s+/g, "");
  const phone = profile.basics.phone.replace(/\D/g, "");
  const wanted = [
    ...(email ? [{ name: "email", found: squeezed.includes(email) }] : []),
    ...(phone ? [{ name: "phone number", found: squeezed.replace(/\D/g, "").includes(phone) }] : []),
  ];
  if (wanted.length === 0) {
    return { id: "contact", level: "warn", title: "No contact details", detail: "The profile has no email or phone number, so the resume has none for a parser to find." };
  }
  const missing = wanted.filter((item) => !item.found).map((item) => item.name);
  if (missing.length > 0) {
    return {
      id: "contact",
      level: "fail",
      title: `${capitalize(missing.join(" and "))} not in the text`,
      detail: "A parser copies contact details from the text layer; it can't read them off the picture of the page.",
    };
  }
  return { id: "contact", level: "ok", title: "Contact details read as text", detail: `${capitalize(wanted.map((item) => item.name).join(" and "))} found in the text layer.` };
}

function columnsItem({ document, split }: Inputs): CheckItem {
  if (!split) return { id: "columns", level: "ok", title: "One column", detail: "The text reads top to bottom, as a parser reads it." };
  return {
    id: "columns",
    level: "warn",
    title: "Two columns",
    detail: "Parsers that sort text by its position read the sidebar and the main column line by line, mixing skills into roles.",
    fix: document === "base" ? { kind: "theme" } : { kind: "single-column" },
  };
}

function headingsItem({ document, language }: Inputs, headings: string[], labels: DocumentLabels): CheckItem {
  const list = headings.join(", ");
  if (document === "resume" && !language) {
    return { id: "headings", level: "warn", title: "English headings", detail: `No language is recorded for this application, so the headings are the English ones: ${list}.` };
  }
  // documentLabels falls back to the English words for a language it has none for, a built-in one like Hebrew included.
  if (labels === ENGLISH_LABELS && knownLanguage(language)?.tag !== "en") {
    return { id: "headings", level: "warn", title: "English headings", detail: `Dossier has no ${language} headings, so the resume uses the English ones: ${list}.` };
  }
  return { id: "headings", level: "ok", title: "Standard headings", detail: list };
}

function pagesItem(pages: number, limit: number | null): CheckItem {
  const count = `${pages} ${pages === 1 ? "page" : "pages"}`;
  if (limit === null) return { id: "pages", level: "ok", title: "No page limit", detail: count };
  if (pages > limit) return { id: "pages", level: "warn", title: "Over the page limit", detail: `${count}, limit ${limit}`, fix: { kind: "settings", section: "documents" } };
  return { id: "pages", level: "ok", title: "Within the page limit", detail: `${count}, limit ${limit}` };
}

/** Whether the file name says whose resume it is, by the profile's name or first name (SET-8). */
function fileNameItem(fileName: string, profile: ProfileData): CheckItem {
  const name = profile.basics.name.trim();
  if (!name) return { id: "file-name", level: "warn", title: "File name without your name", detail: "The profile has no name yet, so the file can't carry one." };
  const folded = fold(fileName);
  if ([name, name.split(/\s+/)[0]].some((part) => hasWords(folded, fold(part)))) {
    return { id: "file-name", level: "ok", title: "File name carries your name", detail: `Downloads as “${fileName}”.` };
  }
  return {
    id: "file-name",
    level: "warn",
    title: "File name without your name",
    detail: "Recruiters keep many files: put {name} or {first} in the pattern in Settings → Documents.",
    fix: { kind: "settings", section: "documents" },
  };
}

/**
 * The photo, when it prints: usual in Germany, Austria and Switzerland, and
 * a reason to set a resume aside in some other countries. The posting's
 * location and work mode say where it is; when they don't, the profile's
 * country stands in where the posting is the user's own place.
 */
function photoItem({ document, place, profile }: Inputs, content: ResumeContent): CheckItem | null {
  if (!content.photo) return null;
  const ok = (detail: string): CheckItem => ({ id: "photo", level: "ok", title: "Photo on the resume", detail });
  const usual = ok("A photo is usual in Germany, Austria and Switzerland.");
  const named = countriesNamed(place);
  let where: string;
  if (named.codes.length > 0) {
    if (named.codes.some((code) => DACH.includes(code))) return usual;
    where = `Where this posting is (${named.regions[0] ?? named.codes.slice(0, 2).map(countryName).join(" or ")})`;
  } else {
    // Without a country named, the profile's country stands in only where the posting is the user's own: the base resume, a
    // remote job, no place given, or the user's city. A city elsewhere could be in any country.
    const reached = reach(place, placeOf(profile.basics));
    if (document === "resume" && place.trim() && !reached.remote && reached.here !== "city") return ok("Dossier can't tell which country the posting is in.");
    const code = countryCodeFor(profile.basics.country);
    if (!code) return ok("Dossier can't tell which country the posting is in.");
    if (DACH.includes(code)) return usual;
    where = `Where you are (${countryName(code)})`;
  }
  return {
    id: "photo",
    level: "warn",
    title: "Photo on the resume",
    detail: `${where}, a photo on a resume is unusual, and some employers set one with a photo aside.`,
    fix: { kind: "photo" },
  };
}

/**
 * The posting's requirements against the text a parser reads: named when
 * its words are there, one after the other (or, for two words, on one
 * line), and in the profile when the match or the profile's own lists say so.
 * Years of experience are a sum, not a word, so they're left out. The
 * headings are left out of the text searched: one printed in letter-spaced
 * capitals reads back letter by letter, and its letters would name "C" or "R".
 */
function requirementChecks(
  { role, extracted, match }: NonNullable<Inputs["posting"]>,
  profile: ProfileData,
  raw: string,
  headings: string[],
): ResumeCheck["requirements"] {
  if (!extracted || extracted.requirements.length === 0) return null;
  const headingKeys = new Set(headings.map((heading) => fold(heading).replace(/ /g, "")));
  const body = raw.split("\n").filter((line) => !headingKeys.has(fold(line).replace(/ /g, "")));
  const text = body.join("\n");
  const haystack = ` ${tokensOf(text).join(" ")} `;
  const lines = body.map((line) => new Set(tokensOf(line)));
  const named = (phrase: string) => {
    const needle = tokensOf(phrase);
    if (needle.length === 0) return false;
    // "C++", "C#", "R" or "Go": folding leaves a letter or two that many a word holds, so the name is looked for as written.
    if (needle.join("").length <= 2 || /[+#]/.test(phrase)) return asWritten(phrase).test(text);
    if (haystack.includes(` ${needle.join(" ")} `)) return true;
    return needle.length === 2 && lines.some((line) => needle.every((token) => line.has(token)));
  };
  const items = extracted.requirements.flatMap((requirement, index): RequirementCheck[] => {
    if (requirement.kind === "years") return [];
    const phrase = ((requirement.kind === "language" ? requirement.language : requirement.skill) ?? requirement.text).trim();
    if (!phrase) return [];
    // A language lives in the Languages section, so it's never one to add to Skills.
    const skill = requirement.kind === "language" ? null : skillSpelling(phrase, match?.items[index], profile);
    const inProfile = skill !== null || profile.languages.some((language) => sameName(language.name, phrase));
    return [{ index, requirement: requirement.text, named: named(phrase), inProfile, skill }];
  });
  if (items.length === 0) return null;
  const title = role ? [{ index: -1, requirement: role, named: named(role), inProfile: titleInProfile(role, profile), skill: null }] : [];
  return { items: [...title, ...items], named: items.filter((item) => item.named).length, total: items.length };
}

/** A name as written, with no letter, digit, "+" or "#" right before or after it: "C" isn't in "C#", nor "Go" in "Google". Letters only keep their case. */
function asWritten(phrase: string): RegExp {
  const escaped = phrase.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\p{L}\\p{N}+#])${escaped}(?![\\p{L}\\p{N}+#])`, /[+#]/.test(phrase) ? "iu" : "u");
}

/** How the profile spells a requirement's skill, or null when it has none: the match's answer first, then the Skills list. A language the match named is no skill. */
function skillSpelling(phrase: string, item: Match["items"][number] | undefined, profile: ProfileData): string | null {
  const fromMatch = item && item.result !== "gap" ? item.skill : null;
  const isLanguage = (name: string) =>
    profile.languages.some((language) => sameName(language.name, name)) && !profile.skills.some((skill) => sameSkill(skill.name, name));
  if (fromMatch && !isLanguage(fromMatch)) return fromMatch;
  return profile.skills.find((skill) => sameSkill(skill.name, phrase))?.name ?? null;
}

/** Whether the profile already calls the user that, in the headline or a role. */
const titleInProfile = (role: string, profile: ProfileData) => sameSkill(profile.basics.headline, role) || profile.experience.some((entry) => sameSkill(entry.role, role));

/**
 * Characters a parser misreads, counted by kind in the text as it was read.
 * The zero-width joiner and non-joiner aren't among them: Persian, Arabic and
 * the Indic scripts need them, and the clean-up keeps them. The clean-up is
 * offered only when the resume's own parts hold some: the name, headline,
 * contact line and titles print from the profile, publications word for word.
 */
function charactersItem(raw: string, { document, units }: Inputs): CheckItem {
  const kinds: [string, RegExp][] = [
    ["ligature glyph", /[\uFB00-\uFB06]/g],
    ["non-breaking hyphen", /\u2011/g],
    ["typographic hyphen", /\u2010/g],
    ["soft hyphen", /\u00AD/g],
    ["zero-width character", /[\u200B\u2060\uFEFF]/g],
  ];
  const found = kinds.map(([name, pattern]) => ({ name, count: (raw.match(pattern) ?? []).length })).filter(({ count }) => count > 0);
  if (found.length === 0) return { id: "characters", level: "ok", title: "Plain characters", detail: "No ligature glyphs, odd hyphens or invisible characters." };
  const list = found.map(({ name, count }) => `${count} ${name}${count === 1 ? "" : "s"}`).join(", ");
  const title = "Characters parsers misread";
  if (document === "base") {
    return { id: "characters", level: "fail", title, detail: `${list}. The base resume prints the profile's text, so fix them on the Profile screen.` };
  }
  if (!(units ?? []).some((unit) => !isPublicationUnit(unit.id) && FIXABLE.test(unit.text))) {
    return { id: "characters", level: "fail", title, detail: `${list}. They print from your profile (the headline, a title or a publication), so fix them on the Profile screen.` };
  }
  return {
    id: "characters",
    level: "fail",
    title,
    detail: `${list}. A parser reads a ligature as one unknown letter and breaks a word on an invisible character.`,
    fix: { kind: "clean-up" },
  };
}

/** Whether the text is in the language the headings and dates follow, read from the parts themselves. */
function languageItem(language: string, units: Unit[]): CheckItem {
  const detected = detectLanguageName(units.map((unit) => unit.text).join("\n"));
  const recorded = knownLanguage(language)?.name;
  const fix = detected ? { fix: { kind: "language", language: detected } as const } : {};
  if (!language) {
    return {
      id: "language",
      level: "warn",
      title: "No language recorded",
      detail: detected ? `The headings and dates are English, while the text reads as ${detected}.` : "The headings and dates are English.",
      ...fix,
    };
  }
  if (detected && recorded && detected !== recorded) {
    return {
      id: "language",
      level: "warn",
      title: `Text in ${detected} under ${recorded} headings and dates`,
      detail: `The application is set to ${recorded}, which the headings and dates follow, but the text reads as ${detected}.`,
      ...fix,
    };
  }
  // A language added in Settings: Dossier has no words to read it by, so it can't say the text agrees.
  if (!recorded) return { id: "language", level: "ok", title: `Written in ${language}`, detail: "Dossier can't read text in this language to compare it." };
  return { id: "language", level: "ok", title: `Written in ${recorded}`, ...(detected ? { detail: "The headings, dates and text agree." } : {}) };
}

/** Date ranges in one style: the document's own word for an ongoing role, not a range ending in "Present" beside it. */
function datesItem(raw: string, labels: DocumentLabels): CheckItem {
  if (labels.present !== "Present" && /[\u2013\u2014-]\s*Present\b/.test(raw)) {
    return { id: "dates", level: "warn", title: "Mixed date words", detail: `A range ends in “Present”; this resume's ranges end in “${labels.present}”.` };
  }
  return { id: "dates", level: "ok", title: "Dates in one style", detail: "Every range reads the same way." };
}

/**
 * The "clean-up" fix: the tailored resume's and cover letter's parts with
 * their characters put right (plainText), so a ligature glyph, an odd hyphen
 * or an invisible character a model left behind goes. Nothing else changes:
 * a bullet keeps its "1.", and only a line the normaliser empties, or a
 * bullet character it uncovers, goes.
 * Publications stay word for word (#218).
 */
export async function cleanDocumentText(applicationId: string): Promise<void> {
  await updateDocuments(applicationId, async (documents) => {
    for (const kind of [DocumentKind.RESUME, DocumentKind.COVER_LETTER]) {
      for (const unit of documents[kind] ?? []) {
        if (!isPublicationUnit(unit.id)) unit.text = plainCharacters(unit.text, isBulletUnit(unit.id));
      }
    }
  });
}

function plainCharacters(text: string, bullets: boolean): string {
  return text
    .split("\n")
    .filter((line) => line.trim() === "" || plainText(line).trim() !== "")
    .map((line) => {
      const plain = plainText(line);
      // A bullet written with a non-breaking hyphen: the "-" the normaliser uncovered goes, as a hand edit's would.
      return bullets && MARKER.test(plain) && !MARKER.test(line) ? plain.replace(MARKER, "") : plain;
    })
    .join("\n");
}

const MARKER = /^\s*-\s+/;
