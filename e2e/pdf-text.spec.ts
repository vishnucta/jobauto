import { expect, test, type Page } from "@playwright/test";
import { extractText } from "unpdf";

import { resetData, setProfileSetting, sql } from "./support";

// The PDF's text layer, as a parser reads it: every word and the dates come
// back as the characters they were written with. That takes
// `font-variant-ligatures: none` in document.module.css. Without it, Manrope
// draws "ffi" as one glyph that reads back as U+E007 and Inter draws " – " as
// an alternate that reads back as U+E089, so "office" and "Mar 2021 – Present"
// are gone for anyone searching the file (measured with Chromium 153).
test.beforeAll(async () => {
  await resetData();
  // A bullet with the letter pairs the demo text lacks.
  await sql(`UPDATE "Experience" SET bullets = bullets || $1 WHERE company = 'Northwind Logistics'`, ["\nRefit the financial workflow for the office"]);
});

/** The base resume's PDF as one text, the way the profile import reads a PDF (src/lib/resume-text.ts). */
async function pdfText(page: Page): Promise<string> {
  const response = await page.request.get("/api/pdf?doc=base");
  expect(response.ok()).toBe(true);
  return (await extractText(new Uint8Array(await response.body()), { mergePages: true })).text;
}

for (const [theme, font] of [
  ["signal", "Manrope"],
  ["atlas", "Inter"],
] as const) {
  test(`keeps words and dates as text in the PDF (${theme}, ${font})`, async ({ page }) => {
    // The first profile's Base resume (E24-1), which /api/pdf?doc=base prints without `&profile=`.
    await setProfileSetting("baseThemeId", theme);
    const text = await pdfText(page);
    expect(text).toContain("Refit the financial workflow for the office");
    expect(text).toContain("Mar 2021 – Present");
    // No ligature characters (U+FB00–FB06) and nothing from the private use area.
    expect(text).not.toMatch(/[ﬀ-ﬆ-]/);
  });
}
