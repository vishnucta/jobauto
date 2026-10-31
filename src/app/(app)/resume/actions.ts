"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { action, ActionError } from "@/lib/action";
import { copyTheme, createTheme, deleteCustomTheme, makeBaseTheme, updateCustomTheme } from "@/lib/theme-changes";
import { parseThemeFile, themeFieldsSchema } from "@/lib/theme-file";
import type { ThemeData } from "@/lib/themes";

// The theme changes themselves are in src/lib/theme-changes.ts, which the
// Claude connector uses too.

const THEME_GONE = "That theme doesn't exist anymore. Reload the page to see your themes.";

/** Makes a theme the base resume theme (RES-2). */
export const setBaseTheme = action(z.object({ id: z.string().min(1) }), async ({ id }) => {
  if (!(await makeBaseTheme(id))) throw new ActionError(THEME_GONE);
  revalidatePath("/resume");
  return null;
});

/**
 * Saves the theme builder's draft (RES-3, RES-4) and makes it the base
 * theme: a new custom theme without an id, or an existing custom theme
 * edited in place. Built-in themes can't be changed.
 */
export const saveTheme = action(
  themeFieldsSchema.extend({ id: z.string().min(1).nullable() }),
  async ({ id, ...fields }, { toast }): Promise<ThemeData> => {
    const theme = id ? await updateCustomTheme(id, fields) : await createTheme(fields);
    if (theme === "not-found") throw new ActionError(THEME_GONE);
    if (theme === "built-in") throw new ActionError("Built-in themes can't be changed. Save it as a new theme instead.");
    toast(`Saved “${theme.name}”. It's now your base resume theme.`);
    revalidatePath("/resume");
    return theme;
  },
);

// ─── Managing themes (E5-7, RES-8) ───────────────────────────────────────────

/** A copy of any theme, built-in or custom, as a new custom theme; it becomes the base theme. */
export const duplicateTheme = action(z.object({ id: z.string().min(1) }), async ({ id }, { toast }): Promise<ThemeData> => {
  const copy = await copyTheme(id);
  if (!copy) throw new ActionError(THEME_GONE);
  toast(`Made “${copy.name}”. It's now your base resume theme.`);
  revalidatePath("/resume");
  return copy;
});

/** Deletes a custom theme (deleteCustomTheme says what becomes of its documents). Answers with the base theme after. */
export const deleteTheme = action(z.object({ id: z.string().min(1) }), async ({ id }, { toast }) => {
  const deleted = await deleteCustomTheme(id);
  if (deleted === "not-found") throw new ActionError(THEME_GONE);
  if (deleted === "built-in") throw new ActionError("Built-in themes can't be deleted.");
  toast(`Deleted “${deleted.name}”.`);
  revalidatePath("/resume");
  return { baseThemeId: deleted.baseThemeId };
});

/** A theme from an exported theme file, checked again here; it becomes the base theme. */
export const importTheme = action(z.object({ file: z.unknown() }), async ({ file }, { toast }): Promise<ThemeData> => {
  const read = parseThemeFile(file);
  if (!read.ok) throw new ActionError(read.error);
  const theme = await createTheme(read.theme);
  toast(`Imported “${theme.name}”. It's now your base resume theme.`);
  revalidatePath("/resume");
  return theme;
});
