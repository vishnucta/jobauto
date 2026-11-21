"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { action, ActionError } from "@/lib/action";
import { DOCUMENT_LANGUAGES } from "@/lib/document-language";
import { prisma } from "@/lib/prisma";
import { saveProfileSettings } from "@/lib/profiles";
import { checkResume } from "@/lib/resume-check";
import { sectionLayoutSchema } from "@/lib/resume-sections";
import { copyTheme, createTheme, deleteCustomTheme, makeBaseTheme, updateCustomTheme } from "@/lib/theme-changes";
import { parseThemeFile, themeFieldsSchema } from "@/lib/theme-file";
import type { ThemeData } from "@/lib/themes";

// The theme changes themselves are in src/lib/theme-changes.ts, which the
// Claude connector uses too.

const THEME_GONE = "That theme doesn't exist anymore. Reload the page to see your themes.";

// Each profile has its own Base resume (E24-1): these say which profile's.
const profileId = z.string().min(1);

/** The profile asked for, when it still exists (another tab may have deleted it). */
async function ownProfile(id: string): Promise<string> {
  if (!(await prisma.profile.count({ where: { id } }))) throw new ActionError("That profile no longer exists. Reload the page.");
  return id;
}

/** Makes a theme the base resume theme (RES-2). */
export const setBaseTheme = action(z.object({ profileId, id: z.string().min(1) }), async ({ profileId, id }) => {
  if (!(await makeBaseTheme(await ownProfile(profileId), id))) throw new ActionError(THEME_GONE);
  revalidatePath("/resume");
  return null;
});

/** The base resume's order, from Profile or the Sections tab (#297), and which sections are on resumes. */
export const saveResumeSections = action(sectionLayoutSchema.extend({ profileId }), async ({ profileId, ...resumeSections }) => {
  await saveProfileSettings(await ownProfile(profileId), { resumeSections });
  revalidatePath("/resume");
  revalidatePath("/profile");
  return null;
});

/** The Base resume's language (E24-2), for its headings and dates: one of the built-in languages, or null for English. */
export const setBaseResumeLanguage = action(
  z.object({
    profileId,
    language: z
      .string()
      .refine((name) => DOCUMENT_LANGUAGES.some((language) => language.name === name), "Pick a language from the list.")
      .nullable(),
  }),
  async ({ profileId, language }) => {
    await saveProfileSettings(await ownProfile(profileId), { resumeLanguage: language });
    revalidatePath("/resume");
    return null;
  },
);

/** "Fit to one page" (public issue 69): saved at once; the preview and the PDF squeeze the resume until it fits. */
export const setFitBaseResume = action(z.object({ profileId, fit: z.boolean() }), async ({ profileId, fit }) => {
  await saveProfileSettings(await ownProfile(profileId), { fitBaseResume: fit });
  revalidatePath("/resume");
  return null;
});

/**
 * Saves the theme builder's draft (RES-3, RES-4) and makes it the base
 * theme: a new custom theme without an id, or an existing custom theme
 * edited in place. Built-in themes can't be changed.
 */
export const saveTheme = action(
  themeFieldsSchema.extend({ profileId, id: z.string().min(1).nullable() }),
  async ({ profileId, id, ...fields }, { toast }): Promise<ThemeData> => {
    await ownProfile(profileId);
    const theme = id ? await updateCustomTheme(profileId, id, fields) : await createTheme(profileId, fields);
    if (theme === "not-found") throw new ActionError(THEME_GONE);
    if (theme === "built-in") throw new ActionError("Built-in themes can't be changed. Save it as a new theme instead.");
    toast(`Saved “${theme.name}”. It's now your base resume theme.`);
    revalidatePath("/resume");
    return theme;
  },
);

// ─── Managing themes (E5-7, RES-8) ───────────────────────────────────────────

/** A copy of any theme, built-in or custom, as a new custom theme; it becomes the base theme. */
export const duplicateTheme = action(z.object({ profileId, id: z.string().min(1) }), async ({ profileId, id }, { toast }): Promise<ThemeData> => {
  const copy = await copyTheme(await ownProfile(profileId), id);
  if (!copy) throw new ActionError(THEME_GONE);
  toast(`Made “${copy.name}”. It's now your base resume theme.`);
  revalidatePath("/resume");
  return copy;
});

/** Deletes a custom theme (deleteCustomTheme says what becomes of its documents). Answers with the open profile's base theme after. */
export const deleteTheme = action(z.object({ profileId, id: z.string().min(1) }), async ({ profileId, id }, { toast }) => {
  const deleted = await deleteCustomTheme(await ownProfile(profileId), id);
  if (deleted === "not-found") throw new ActionError(THEME_GONE);
  if (deleted === "built-in") throw new ActionError("Built-in themes can't be deleted.");
  toast(`Deleted “${deleted.name}”.`);
  revalidatePath("/resume");
  return { baseThemeId: deleted.baseThemeId };
});

/**
 * "Check for ATS" on the Base resume screen: prints the profile's base
 * resume as Download PDF does and reads it back the way a parser would
 * (src/lib/resume-check.ts, which the Claude connector uses too). The report
 * holds labels and counts, never the text.
 */
export const checkBaseResumeAts = action(z.object({ profileId }), async ({ profileId }) => {
  const report = await checkResume("base", "", await ownProfile(profileId));
  if ("error" in report) throw new ActionError(report.error);
  return report;
});

/** A theme from an exported theme file, checked again here; it becomes the base theme. */
export const importTheme = action(z.object({ profileId, file: z.unknown() }), async ({ profileId, file }, { toast }): Promise<ThemeData> => {
  const read = parseThemeFile(file);
  if (!read.ok) throw new ActionError(read.error);
  const theme = await createTheme(await ownProfile(profileId), read.theme);
  toast(`Imported “${theme.name}”. It's now your base resume theme.`);
  revalidatePath("/resume");
  return theme;
});
