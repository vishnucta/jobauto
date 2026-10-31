import "server-only";

import { prisma } from "@/lib/prisma";
import { DEFAULT_BASE_THEME } from "@/lib/settings";
import { loadSettings, saveSettings } from "@/lib/settings-data";
import { loadTheme, THEME_FIELDS } from "@/lib/theme-data";
import type { ThemeFields } from "@/lib/theme-file";
import type { ThemeData } from "@/lib/themes";

// Changes to the resume themes (RES-2…RES-4, E5-7), for the resume screen's
// actions and the Claude connector (#221). A theme that's saved, copied or
// imported becomes the base theme. Built-in themes are never changed.

/** Makes a theme the base resume theme (RES-2); null when it doesn't exist. */
export async function makeBaseTheme(id: string): Promise<ThemeData | null> {
  const theme = await loadTheme(id);
  if (theme) await saveSettings({ baseThemeId: id });
  return theme;
}

/** A new custom theme (RES-4), from the theme builder's draft, a copy or a theme file; it becomes the base theme. */
export async function createTheme(fields: ThemeFields): Promise<ThemeData> {
  return prisma.$transaction(async (tx) => {
    const created = await tx.theme.create({ data: fields, select: THEME_FIELDS });
    await saveSettings({ baseThemeId: created.id }, tx);
    return created;
  });
}

/** A custom theme edited in place (RES-3), which becomes the base theme; or why it can't be. */
export async function updateCustomTheme(id: string, fields: ThemeFields): Promise<ThemeData | "not-found" | "built-in"> {
  return prisma.$transaction(async (tx): Promise<ThemeData | "not-found" | "built-in"> => {
    const existing = await tx.theme.findUnique({ where: { id }, select: { builtIn: true } });
    if (!existing) return "not-found";
    if (existing.builtIn) return "built-in";
    const saved = await tx.theme.update({ where: { id }, data: fields, select: THEME_FIELDS });
    await saveSettings({ baseThemeId: saved.id }, tx);
    return saved;
  });
}

/** A copy of any theme, built-in or custom, as a new custom theme (E5-7); it becomes the base theme. Null when it doesn't exist. */
export async function copyTheme(id: string): Promise<ThemeData | null> {
  const original = await prisma.theme.findUnique({ where: { id }, select: { ...THEME_FIELDS, id: false, builtIn: false } });
  if (!original) return null;
  return createTheme({ ...original, name: `${original.name} copy`.slice(0, 60) });
}

/**
 * Deletes a custom theme (E5-7). Documents that used it render in the base
 * theme from then on (the database drops the link); if it was the base
 * theme, Editorial takes over. Answers with its name and the base theme
 * after, or why it can't be deleted.
 */
export async function deleteCustomTheme(id: string): Promise<{ name: string; baseThemeId: string } | "not-found" | "built-in"> {
  const theme = await prisma.theme.findUnique({ where: { id }, select: { name: true, builtIn: true } });
  if (!theme) return "not-found";
  if (theme.builtIn) return "built-in";
  const baseThemeId = await prisma.$transaction(async (tx) => {
    let base = (await loadSettings()).baseThemeId;
    if (base === id) {
      base = DEFAULT_BASE_THEME;
      await saveSettings({ baseThemeId: base }, tx);
    }
    await tx.theme.delete({ where: { id } });
    return base;
  });
  return { name: theme.name, baseThemeId };
}
