// The text of a tailored document's unit, as saved. Imported by client
// components too, so it stays free of server-only dependencies.

/** Characters that print as nothing but split a word for a resume parser: zero-width space, word joiner, byte-order mark, soft hyphen. */
const INVISIBLE = /[​⁠﻿­]/g;

/** The non-breaking hyphen and the Unicode hyphen, which a parser doesn't read as the "-" in "front-end". */
const HYPHENS = /[‐‑]/g;

/** The Latin ligature glyphs (ﬀ ﬁ ﬂ ﬃ ﬄ ﬅ ﬆ), which a parser reads as one unknown letter. */
const LIGATURES = /[ﬀ-ﬆ]/g;

/**
 * Text as a resume parser should see it: the invisible characters a model or
 * a paste leaves behind go, the odd hyphens become "-" and the ligature glyphs
 * become their letters. A whole-string NFKC is the wrong tool: it maps U+2011
 * to U+2010 (still no "-"), rewrites ½ and ², and turns a non-breaking space
 * into a plain one. En and em dashes stay ("2015–2018", citations), and so do
 * the ZWNJ and ZWJ (U+200C, U+200D) that Persian and Arabic words need.
 */
export function plainText(text: string): string {
  return text
    .replace(INVISIBLE, "")
    .replace(HYPHENS, "-")
    .replace(LIGATURES, (glyph) => glyph.normalize("NFKC"));
}

/** Bullet characters a model may add even when asked not to, and people type out of habit. */
const BULLET = /^\s*(?:[-*•·]|\d+[.)])\s+/;

/** A role's or project's bullets are one per line, without bullet characters or empty lines. */
export function bulletLines(text: string): string {
  // Normalised first, so a non-breaking hyphen counts as a bullet and a line of invisible characters as empty.
  return plainText(text)
    .split("\n")
    .map((line) => line.replace(BULLET, "").trim())
    .filter(Boolean)
    .join("\n");
}

/** Whether a unit holds a role or a project, whose text is a list of bullets. */
export function isBulletUnit(unitId: string): boolean {
  return unitId.startsWith("experience:") || unitId.startsWith("project:");
}

/** Whether a unit holds a publication (#218): the user's citation, which the AI never rewrites. */
export function isPublicationUnit(unitId: string): boolean {
  return unitId.startsWith("publication:");
}

/** Text for a unit as written in the editor: normalised, a role's or project's bullets cleaned up, anything else trimmed. */
export function cleanUnitText(unitId: string, text: string): string {
  return isBulletUnit(unitId) ? bulletLines(text) : plainText(text).trim();
}

/**
 * How a unit is called in a sentence, after "the": "summary", "opening
 * paragraph", or a role's, project's, degree's or publication's own name, e.g. "Northwind Logistics role".
 */
export function unitName(unit: { id: string; label: string }): string {
  const label = unit.label.trim();
  if (["experience:", "project:", "education:", "publication:"].some((prefix) => unit.id.startsWith(prefix))) return label || "entry";
  if (unit.id.startsWith("paragraph:")) {
    const name = label.toLowerCase() || "paragraph";
    return /\bparagraph$/.test(name) ? name : `${name} paragraph`;
  }
  return label.toLowerCase() || "part";
}
