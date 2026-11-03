import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Extracted, Match, Requirement, Unit } from "@/lib/application-data";
import { demoProfile, demoResumeUnits } from "@/lib/demo-profile";
import { documentLabels, ENGLISH_LABELS, type DocumentLabels } from "@/lib/document-labels";
import { updateDocuments, type DocumentUnits } from "@/lib/document-units";
import { renderPdf } from "@/lib/pdf/render";
import { prisma } from "@/lib/prisma";
import { loadProfile, loadProfileName } from "@/lib/profile-data";
import { resumeContent, type ResumeContent } from "@/lib/resume-content";
import { settingsFromRows } from "@/lib/settings";
import { loadSettings } from "@/lib/settings-data";
import { loadTheme } from "@/lib/theme-data";
import { BUILT_IN_THEMES } from "@/lib/themes";
import { pdfWith } from "@/test/resume-files";

import { checkResume, cleanDocumentText, type ResumeCheck } from "./resume-check";

vi.mock("@/lib/pdf/render", () => ({ renderPdf: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: { application: { findUnique: vi.fn() } } }));
vi.mock("@/lib/profile-data", () => ({ loadProfile: vi.fn(), loadProfileName: vi.fn() }));
vi.mock("@/lib/settings-data", () => ({ loadSettings: vi.fn() }));
vi.mock("@/lib/theme-data", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/theme-data")>()), loadTheme: vi.fn() }));
vi.mock("@/lib/document-units", () => ({ updateDocuments: vi.fn() }));
// What pdf.js reads from the PDF, when a test says so: the test PDF's Helvetica can't carry a ligature glyph or an invisible character.
const fake = vi.hoisted(() => ({ text: null as string | null }));
vi.mock("unpdf", async (importOriginal) => {
  const actual = await importOriginal<typeof import("unpdf")>();
  return {
    ...actual,
    getDocumentProxy: (data: Uint8Array) => (fake.text === null ? actual.getDocumentProxy(data) : Promise.resolve({})),
    extractText: (data: never, options: never) => (fake.text === null ? actual.extractText(data, options) : Promise.resolve({ totalPages: 1, text: fake.text })),
  };
});

const profile = demoProfile();
const units = demoResumeUnits();
const tailored = resumeContent(profile, { units }, ENGLISH_LABELS);
const modern = BUILT_IN_THEMES.find((theme) => theme.id === "modern")!;
/** A PDF of two pages that pdf.js can't read: for the page count, with the text written by hand. */
const TWO_PAGES = new TextEncoder().encode("%PDF-1.4\n1 0 obj << /Type /Page >> endobj\n2 0 obj << /Type /Page >> endobj\n%%EOF");
const PHOTO = { src: "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ", onResumes: true };

const requirement = (text: string, kind: Requirement["kind"], detail: Partial<Requirement> = {}): Requirement => ({ text, kind, skill: null, years: null, language: null, ...detail });
const extractedOf = (requirements: Requirement[], role: string | null = "Senior Product Designer"): Extracted => ({
  title: null,
  company: "Ledgerly",
  role,
  location: "Amsterdam, Netherlands",
  mode: null,
  salary: null,
  deadline: null,
  requirements,
  asksForReferences: false,
  language: "English",
});
const matchItem = (requirement: string, result: Match["items"][number]["result"], skill: string | null): Match["items"][number] => ({ requirement, result, skill, experienceIds: [], note: null });

/** An application as the check's select and renderDocumentPdf's (company, role, documents) read it. */
type Row = {
  id: string;
  company: string;
  role: string;
  location: string;
  mode: string;
  language: string;
  extracted: Extracted | null;
  match: Match | null;
  followThemeLayout: boolean;
  showPhoto: boolean | null;
  documents: { id: string; units: Unit[]; theme: (typeof modern) | null }[];
};
const row = (overrides: Partial<Row> = {}): Row => ({
  id: "app1",
  company: "Ledgerly",
  role: "",
  location: "Amsterdam, Netherlands",
  mode: "Hybrid",
  language: "English",
  extracted: null,
  match: null,
  followThemeLayout: false,
  showPhoto: null,
  documents: [{ id: "doc1", units, theme: null }],
  ...overrides,
});

/** The resume's lines as its PDF reads back, in ASCII (the test PDF's Helvetica has no en dash or middle dot). */
function resumeLines(content: ResumeContent, labels: DocumentLabels = ENGLISH_LABELS, split = false): string[] {
  const ascii = (line: string) => line.replace(/[^\x20-\x7e]/g, "-");
  const entry = (title: string, at: string, dates: string, bullets: string[]) => [`${title}, ${at} ${dates}`, ...bullets];
  const sidebar = [
    ...(split ? [labels.contact, ...content.contacts] : []),
    ...(content.skills ? [labels.skills, content.skills] : []),
    ...(content.languages ? [labels.languages, content.languages] : []),
  ];
  const main = [
    ...(content.summary ? [labels.profile, content.summary] : []),
    ...(content.experience.length ? [labels.experience, ...content.experience.flatMap((role) => entry(role.role, role.company, role.dates, role.bullets))] : []),
    ...(content.projects.length ? [labels.projects, ...content.projects.flatMap((project) => entry(project.name, project.link, project.dates, project.bullets))] : []),
    ...(content.education.length ? [labels.education, ...content.education.flatMap((entry) => [`${entry.degree}, ${entry.school} ${entry.dates}`, entry.notes])] : []),
    ...(content.publications.length ? [labels.publications, ...content.publications.map((entry) => entry.citation)] : []),
  ];
  return [content.name, content.headline, ...(split ? [] : [content.contacts.join("  -  ")]), ...(split ? [...sidebar, ...main] : [...main, ...sidebar])]
    .filter(Boolean)
    .map(ascii);
}

const check = async (doc: "base" | "resume" = "resume"): Promise<ResumeCheck> => {
  const result = await checkResume(doc, doc === "resume" ? "app1" : undefined);
  if ("error" in result) throw new Error(result.error);
  return result;
};
const item = (report: ResumeCheck, id: string) => [...report.reads, ...report.text].find((entry) => entry.id === id)!;

beforeEach(() => {
  fake.text = null;
  vi.mocked(loadProfile).mockResolvedValue(profile);
  vi.mocked(loadProfileName).mockResolvedValue("Jane Doe");
  vi.mocked(loadSettings).mockResolvedValue(settingsFromRows([]));
  vi.mocked(loadTheme).mockResolvedValue(null);
  vi.mocked(prisma.application.findUnique).mockReset().mockResolvedValue(row() as never);
  vi.mocked(renderPdf).mockReset().mockResolvedValue(pdfWith(resumeLines(tailored)));
});

describe("checkResume", () => {
  it("reads a single-column resume as a parser would, and keeps the document's text out of the report", async () => {
    const report = await check();
    expect(renderPdf).toHaveBeenCalledWith("/print/resume/app1");
    expect(report).toMatchObject({ document: "resume", fileName: "Jane Doe – Ledgerly – Resume.pdf", pages: 1, maxPages: 2, requirements: null });
    expect(report.reads.map((entry) => [entry.id, entry.level])).toEqual([
      ["text-layer", "ok"],
      ["contact", "ok"],
      ["columns", "ok"],
      ["headings", "ok"],
      ["pages", "ok"],
      ["file-name", "ok"],
    ]);
    expect(item(report, "text-layer").detail).toMatch(/^Every heading, title and bullet is in the PDF's text layer \(\d+ checked\)\.$/);
    expect(item(report, "contact").detail).toBe("Email and phone number found in the text layer.");
    expect(item(report, "headings").detail).toBe("Profile, Experience, Projects, Education, Publications, Skills, Languages");
    expect(item(report, "pages").detail).toBe("1 page, limit 2");
    expect(report.text.map((entry) => [entry.id, entry.level, entry.title])).toEqual([
      ["characters", "ok", "Plain characters"],
      ["language", "ok", "Written in English"],
      ["dates", "ok", "Dates in one style"],
    ]);
    expect(report.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const json = JSON.stringify(report);
    for (const secret of ["jane.doe@example.com", "+31 6 1234 5678", "1234 5678", tailored.experience[0].bullets[0], tailored.summary.slice(0, 40)]) {
      expect(json).not.toContain(secret);
    }
  });

  it("fails the text layer when a heading is missing, naming it by its label", async () => {
    vi.mocked(renderPdf).mockResolvedValue(pdfWith(resumeLines(tailored).filter((line) => line !== "Education")));
    const report = await check();
    expect(item(report, "text-layer")).toEqual({
      id: "text-layer",
      level: "fail",
      title: "Text a parser can't find",
      detail: "The PDF's text layer is missing the Education heading. A parser reads that layer, not the picture of the page.",
    });
  });

  it("says when a bullet or the phone number isn't in the text, without quoting either", async () => {
    const lines = resumeLines(tailored);
    vi.mocked(renderPdf).mockResolvedValue(pdfWith(lines.map((line) => (line === tailored.experience[0].bullets[1] ? "" : line.replace("+31 6 1234 5678", "")))));
    const report = await check();
    expect(item(report, "text-layer").detail).toBe("The PDF's text layer is missing bullet 2 of the Northwind Logistics role. A parser reads that layer, not the picture of the page.");
    expect(item(report, "contact")).toMatchObject({ level: "fail", title: "Phone number not in the text" });
    expect(JSON.stringify(report)).not.toContain("1234");
  });

  it("warns about a sidebar layout, with the fix for the document", async () => {
    vi.mocked(prisma.application.findUnique).mockResolvedValue(row({ followThemeLayout: true, documents: [{ id: "doc1", units, theme: modern }] }) as never);
    vi.mocked(renderPdf).mockResolvedValue(pdfWith(resumeLines(tailored, ENGLISH_LABELS, true)));
    const split = await check();
    expect(item(split, "columns")).toMatchObject({ level: "warn", title: "Two columns", fix: { kind: "single-column" } });
    expect(item(split, "text-layer").level).toBe("ok");
    expect(item(split, "headings").detail).toContain("Contact");

    // The same theme folds into one column unless the resume follows its layout (APP-4).
    vi.mocked(prisma.application.findUnique).mockResolvedValue(row({ documents: [{ id: "doc1", units, theme: modern }] }) as never);
    vi.mocked(renderPdf).mockResolvedValue(pdfWith(resumeLines(tailored)));
    expect(item(await check(), "columns")).toMatchObject({ level: "ok", title: "One column" });

    // The base resume always prints the base theme's layout: the fix is another theme.
    vi.mocked(loadTheme).mockResolvedValue(modern);
    vi.mocked(renderPdf).mockResolvedValue(pdfWith(resumeLines(resumeContent(profile), ENGLISH_LABELS, true)));
    const base = await check("base");
    expect(renderPdf).toHaveBeenLastCalledWith("/print/base");
    expect(base).toMatchObject({ document: "base", fileName: "Jane Doe – Resume.pdf", requirements: null });
    expect(item(base, "columns")).toMatchObject({ level: "warn", fix: { kind: "theme" } });
    expect(item(base, "text-layer").level).toBe("ok");
    expect(base.text.map((entry) => entry.id)).toEqual(["characters", "dates"]);
  });

  it("warns when the resume runs over the page limit, and counts pages without one", async () => {
    fake.text = resumeLines(tailored).join("\n");
    vi.mocked(renderPdf).mockResolvedValue(TWO_PAGES);
    vi.mocked(loadSettings).mockResolvedValue(settingsFromRows([{ key: "pageLimit", value: "1" }]));
    const over = await check();
    expect(over).toMatchObject({ pages: 2, maxPages: 1 });
    expect(item(over, "pages")).toEqual({ id: "pages", level: "warn", title: "Over the page limit", detail: "2 pages, limit 1", fix: { kind: "settings", section: "documents" } });

    vi.mocked(loadSettings).mockResolvedValue(settingsFromRows([{ key: "pageLimit", value: "none" }]));
    const free = await check();
    expect(free.maxPages).toBeNull();
    expect(item(free, "pages")).toEqual({ id: "pages", level: "ok", title: "No page limit", detail: "2 pages" });
  });

  it("warns when the file name doesn't carry the name, and takes the first name", async () => {
    vi.mocked(loadSettings).mockResolvedValue(settingsFromRows([{ key: "fileNamePattern", value: "{company} – {doc}" }]));
    const nameless = await check();
    expect(nameless.fileName).toBe("Ledgerly – Resume.pdf");
    expect(item(nameless, "file-name")).toMatchObject({ level: "warn", title: "File name without your name", fix: { kind: "settings", section: "documents" } });

    vi.mocked(loadSettings).mockResolvedValue(settingsFromRows([{ key: "fileNamePattern", value: "{first}_{doc}" }]));
    const first = await check();
    expect(item(first, "file-name")).toEqual({ id: "file-name", level: "ok", title: "File name carries your name", detail: "Downloads as “Jane_Resume.pdf”." });
  });

  it("notes the photo where resumes don't have one, by the posting's country or else the profile's", async () => {
    vi.mocked(loadProfile).mockResolvedValue({ ...profile, photo: PHOTO });
    const abroad = await check();
    expect(item(abroad, "photo")).toEqual({
      id: "photo",
      level: "warn",
      title: "Photo on the resume",
      detail: "Where this posting is (Netherlands), a photo on a resume is unusual, and some employers set one with a photo aside.",
      fix: { kind: "photo" },
    });

    vi.mocked(prisma.application.findUnique).mockResolvedValue(row({ location: "Berlin, Germany" }) as never);
    expect(item(await check(), "photo")).toEqual({ id: "photo", level: "ok", title: "Photo on the resume", detail: "A photo is usual in Germany, Austria and Switzerland." });

    vi.mocked(prisma.application.findUnique).mockResolvedValue(row({ location: "Remote", mode: "" }) as never);
    expect(item(await check(), "photo").detail).toBe("Where you are (Netherlands), a photo on a resume is unusual, and some employers set one with a photo aside.");

    // A city alone could be in any country, unless it's the user's own.
    vi.mocked(prisma.application.findUnique).mockResolvedValue(row({ location: "Hamburg", mode: "" }) as never);
    expect(item(await check(), "photo")).toEqual({ id: "photo", level: "ok", title: "Photo on the resume", detail: "Dossier can't tell which country the posting is in." });
    vi.mocked(prisma.application.findUnique).mockResolvedValue(row({ location: "Rotterdam", mode: "" }) as never);
    expect(item(await check(), "photo").detail).toBe("Where you are (Netherlands), a photo on a resume is unusual, and some employers set one with a photo aside.");

    vi.mocked(loadProfile).mockResolvedValue({ ...profile, basics: { ...profile.basics, country: "Deutschland" }, photo: PHOTO });
    expect(item(await check(), "photo").level).toBe("ok");

    // No photo, no note: the switch turned it off.
    vi.mocked(prisma.application.findUnique).mockResolvedValue(row({ showPhoto: false }) as never);
    expect(item(await check(), "photo")).toBeUndefined();
  });

  it("checks which requirements the resume names and which the profile has, the job title too", async () => {
    const extracted = extractedOf([
      requirement("5+ years of product design", "years", { years: 5 }),
      requirement("Strong prototyping skills in Figma", "skill", { skill: "Figma" }),
      requirement("Has built or maintained a design system", "skill", { skill: "Design systems" }),
      requirement("Experience with payments or fintech", "other"),
      requirement("Dutch is a plus", "language", { language: "Dutch" }),
    ]);
    const match: Match = {
      items: [
        matchItem("5+ years of product design", "covered", null),
        matchItem("Strong prototyping skills in Figma", "covered", "Figma"),
        matchItem("Has built or maintained a design system", "covered", "Design systems"),
        matchItem("Experience with payments or fintech", "gap", null),
        matchItem("Dutch is a plus", "covered", "Dutch"),
      ],
    };
    vi.mocked(prisma.application.findUnique).mockResolvedValue(row({ extracted, match }) as never);
    const report = await check();
    expect(report.requirements).toEqual({
      items: [
        { index: -1, requirement: "Senior Product Designer", named: true, inProfile: true, skill: null },
        { index: 1, requirement: "Strong prototyping skills in Figma", named: true, inProfile: true, skill: "Figma" },
        { index: 2, requirement: "Has built or maintained a design system", named: true, inProfile: true, skill: "Design systems" },
        { index: 3, requirement: "Experience with payments or fintech", named: false, inProfile: false, skill: null },
        // A language lives in the Languages section: in the profile, but nothing to add to Skills.
        { index: 4, requirement: "Dutch is a plus", named: true, inProfile: true, skill: null },
      ],
      named: 3,
      total: 4,
    });
  });

  it("reads an application Claude saved, whose requirements are plain words without a match", async () => {
    const extracted = extractedOf([requirement("Figma", "other"), requirement("Design systems", "other"), requirement("Kubernetes", "other")], null);
    vi.mocked(prisma.application.findUnique).mockResolvedValue(row({ role: "Product Designer", extracted }) as never);
    const report = await check();
    expect(report.requirements).toEqual({
      items: [
        { index: -1, requirement: "Product Designer", named: true, inProfile: true, skill: null },
        { index: 0, requirement: "Figma", named: true, inProfile: true, skill: "Figma" },
        { index: 1, requirement: "Design systems", named: true, inProfile: true, skill: "Design systems" },
        { index: 2, requirement: "Kubernetes", named: false, inProfile: false, skill: null },
      ],
      named: 2,
      total: 3,
    });

    // Only years asked for: nothing to look for in the text.
    vi.mocked(prisma.application.findUnique).mockResolvedValue(row({ extracted: extractedOf([requirement("5+ years", "years", { years: 5 })]) }) as never);
    expect((await check()).requirements).toBeNull();
  });

  it("fails on characters parsers misread, with the clean-up fix where the resume's own parts hold them", async () => {
    const odd = "Led the \uFB01nance\u2011portal\u2010redesign\u00AD for the \u200Bteam\u2060";
    const dirty = units.map((unit) => (unit.id === "summary" ? { ...unit, text: `${unit.text} ${odd}` } : unit));
    vi.mocked(prisma.application.findUnique).mockResolvedValue(row({ documents: [{ id: "doc1", units: dirty, theme: null }] }) as never);
    fake.text = [...resumeLines(tailored), odd].join("\n");
    const list = "1 ligature glyph, 1 non-breaking hyphen, 1 typographic hyphen, 1 soft hyphen, 2 zero-width characters";
    expect(item(await check(), "characters")).toEqual({
      id: "characters",
      level: "fail",
      title: "Characters parsers misread",
      detail: `${list}. A parser reads a ligature as one unknown letter and breaks a word on an invisible character.`,
      fix: { kind: "clean-up" },
    });

    // The same characters from the profile (the headline, a title): the clean-up can't reach them.
    vi.mocked(prisma.application.findUnique).mockResolvedValue(row() as never);
    expect(item(await check(), "characters")).toEqual({
      id: "characters",
      level: "fail",
      title: "Characters parsers misread",
      detail: `${list}. They print from your profile (the headline, a title or a publication), so fix them on the Profile screen.`,
    });

    const base = await check("base");
    expect(item(base, "characters")).toEqual({
      id: "characters",
      level: "fail",
      title: "Characters parsers misread",
      detail: `${list}. The base resume prints the profile's text, so fix them on the Profile screen.`,
    });

    // The joiners aren't counted: Persian words need them, and the clean-up keeps them.
    fake.text = [...resumeLines(tailored), "نرم\u200Cافزار", "a\u200Db"].join("\n");
    expect(item(await check(), "characters").level).toBe("ok");
  });

  it("finds a bullet with a ligature in it, folded to its letters: the characters check is what counts the ligature", async () => {
    // The ligatures fall inside the six words the check reads.
    const own = units.map((unit) => (unit.id === "experience:e1" ? { ...unit, text: "Defined the financial workflow for field teams" } : unit));
    vi.mocked(prisma.application.findUnique).mockResolvedValue(row({ documents: [{ id: "doc1", units: own, theme: null }] }) as never);
    fake.text = resumeLines(resumeContent(profile, { units: own }, ENGLISH_LABELS))
      .map((line) => line.replace(/fi/g, "\uFB01"))
      .join("\n");
    expect(fake.text).toContain("De\uFB01ned the \uFB01nancial");
    const report = await check();
    expect(item(report, "text-layer").level).toBe("ok");
    expect(item(report, "characters").level).toBe("fail");
  });

  it("finds a bullet in a script without spaces when a line wrap splits it", async () => {
    const bullet = "负责物流调度平台的整体重新设计，该平台每天被四千多名调度员使用";
    const cjk = units.map((unit) => (unit.id === "experience:e1" ? { ...unit, text: bullet } : unit));
    vi.mocked(prisma.application.findUnique).mockResolvedValue(row({ documents: [{ id: "doc1", units: cjk, theme: null }] }) as never);
    const lines = resumeLines(resumeContent(profile, { units: cjk }, ENGLISH_LABELS));
    const printed = bullet.replace(/[^\x20-\x7e]/g, "-");
    expect(lines).toContain(printed);
    // Chromium wraps the line between two characters of the run.
    fake.text = lines.map((line) => (line === printed ? `${bullet.slice(0, 9)}\n${bullet.slice(9)}` : line)).join("\n");
    expect(item(await check(), "text-layer").level).toBe("ok");
    fake.text = lines.filter((line) => line !== printed).join("\n");
    expect(item(await check(), "text-layer")).toMatchObject({ level: "fail", detail: expect.stringMatching(/missing bullet 1 of the /) });
  });

  it("looks for short names as written and outside the headings, and never offers a language for Skills", async () => {
    vi.mocked(prisma.application.findUnique).mockResolvedValue(
      row({
        extracted: extractedOf([
          requirement("C++", "skill", { skill: "C++" }),
          requirement("R", "skill", { skill: "R" }),
          requirement("German", "language", { language: "German" }),
          requirement("Good German", "other"),
        ]),
      }) as never,
    );
    // A heading in letter-spaced capitals reads back letter by letter: "E X P E R I E N C E" holds a "C" and an "R".
    const spaced = resumeLines(tailored).map((line) => (line === "Experience" ? "E X P E R I E N C E" : line));
    fake.text = spaced.join("\n");
    const items = (await check()).requirements!.items.filter((entry) => entry.index >= 0);
    expect(items.map(({ requirement, named, inProfile, skill }) => ({ requirement, named, inProfile, skill }))).toEqual([
      { requirement: "C++", named: false, inProfile: false, skill: null },
      { requirement: "R", named: false, inProfile: false, skill: null },
      { requirement: "German", named: true, inProfile: true, skill: null },
      { requirement: "Good German", named: false, inProfile: false, skill: null },
    ]);

    fake.text = [...spaced, "Built pricing tools in C++ and R"].join("\n");
    expect((await check()).requirements!.items.filter((entry) => entry.index >= 0).map((entry) => entry.named)).toEqual([true, true, true, false]);
  });

  it("warns when the text's language isn't the application's, with the language to set", async () => {
    const german: Record<string, string> = {
      summary:
        "Senior Produktdesignerin mit neun Jahren Erfahrung darin, komplexe Werkzeuge für den Betrieb ruhig und klar zu machen, zuletzt mit dem Carrier-Portal und dem Designsystem bei Northwind Logistics. Das möchte ich in den Zahlungsverkehr bringen, wo Klarheit und Vertrauen am meisten zählen.",
      "experience:e1": "Leitete die Neugestaltung des Portals, das täglich von mehr als 4.000 Disponenten genutzt wird\nBaute ein Designsystem auf, das von drei Produktteams übernommen wurde",
      "experience:e2": "Gestaltete die App für Notizen vom ersten Prototyp bis zu 120.000 Nutzern\nFührte jeden Monat Gespräche mit Nutzern und teilte die Ergebnisse mit dem Team",
      "experience:e3": "Lieferte Webprojekte für Kultureinrichtungen und Gemeinden",
    };
    const germanUnits = units.map((unit) => (german[unit.id] ? { ...unit, text: german[unit.id] } : unit));
    vi.mocked(prisma.application.findUnique).mockResolvedValue(row({ documents: [{ id: "doc1", units: germanUnits, theme: null }] }) as never);
    vi.mocked(renderPdf).mockResolvedValue(pdfWith(resumeLines(resumeContent(profile, { units: germanUnits }, ENGLISH_LABELS))));
    const mismatch = await check();
    expect(item(mismatch, "language")).toEqual({
      id: "language",
      level: "warn",
      title: "Text in German under English headings and dates",
      detail: "The application is set to English, which the headings and dates follow, but the text reads as German.",
      fix: { kind: "language", language: "German" },
    });
    expect(item(mismatch, "headings").level).toBe("ok");

    // An older application without a language: the headings are English whatever the text.
    vi.mocked(prisma.application.findUnique).mockResolvedValue(row({ language: "", documents: [{ id: "doc1", units: germanUnits, theme: null }] }) as never);
    const unknown = await check();
    expect(item(unknown, "language")).toMatchObject({ level: "warn", title: "No language recorded", fix: { kind: "language", language: "German" } });
    expect(item(unknown, "headings")).toMatchObject({ level: "warn", title: "English headings" });

    // Set to German, the headings are German too and all agree.
    const labels = documentLabels("German");
    vi.mocked(prisma.application.findUnique).mockResolvedValue(row({ language: "German", documents: [{ id: "doc1", units: germanUnits, theme: null }] }) as never);
    vi.mocked(renderPdf).mockResolvedValue(pdfWith(resumeLines(resumeContent(profile, { units: germanUnits }, labels), labels)));
    const agreed = await check();
    expect(item(agreed, "language")).toEqual({ id: "language", level: "ok", title: "Written in German", detail: "The headings, dates and text agree." });
    expect(item(agreed, "headings")).toMatchObject({ level: "ok", detail: "Profil, Berufserfahrung, Projekte, Ausbildung, Publikationen, Kenntnisse, Sprachen" });

    // A built-in language without its own headings prints the English ones, and says so.
    vi.mocked(prisma.application.findUnique).mockResolvedValue(row({ language: "Hebrew" }) as never);
    vi.mocked(renderPdf).mockResolvedValue(pdfWith(resumeLines(tailored)));
    expect(item(await check(), "headings")).toMatchObject({ level: "warn", title: "English headings" });

    // A language added in Settings: no words to read it by, so no claim that the text agrees.
    vi.mocked(prisma.application.findUnique).mockResolvedValue(row({ language: "Klingon" }) as never);
    expect(item(await check(), "language")).toEqual({ id: "language", level: "ok", title: "Written in Klingon", detail: "Dossier can't read text in this language to compare it." });
  });

  it("warns about a range ending in “Present” in a resume whose ranges end in another word, not about the word in a bullet", async () => {
    const labels = documentLabels("German");
    vi.mocked(prisma.application.findUnique).mockResolvedValue(row({ language: "German" }) as never);
    const lines = resumeLines(resumeContent(profile, { units }, labels), labels);
    fake.text = [...lines, "Present the roadmap to the board"].join("\n");
    expect(item(await check(), "dates")).toMatchObject({ level: "ok" });
    fake.text = [...lines, "Mentor, Design Club 2019 \u2013 Present"].join("\n");
    expect(item(await check(), "dates")).toEqual({ id: "dates", level: "warn", title: "Mixed date words", detail: "A range ends in “Present”; this resume's ranges end in “Heute”." });
  });

  it("says when the application or its resume is gone, without printing", async () => {
    vi.mocked(prisma.application.findUnique).mockResolvedValue(null);
    expect(await checkResume("resume", "gone")).toEqual({ error: "That application no longer exists." });
    vi.mocked(prisma.application.findUnique).mockResolvedValue(row({ documents: [] }) as never);
    expect(await checkResume("resume", "app1")).toEqual({ error: "This application has no tailored resume." });
    expect(renderPdf).not.toHaveBeenCalled();
  });
});

describe("cleanDocumentText", () => {
  it("puts the characters right in the resume's and the letter's parts, and changes nothing else", async () => {
    const documents: DocumentUnits = {
      RESUME: [
        { id: "summary", label: "Summary", text: "Led the \uFB01nance\u2011portal\u00AD team " },
        { id: "experience:e1", label: "Northwind Logistics role", text: "1. Platz beim Hackathon\n\u200B\n\u2011 Built it" },
        { id: "publication:u1", label: "Doe 2016", text: "Doe, J. (2016). Of\uFB01ce work." },
      ],
      COVER_LETTER: [{ id: "paragraph:1", label: "Opening", text: "A \u200Bfirst paragraph\n\nwith a gap" }],
      EMAIL: [{ id: "body", label: "Body", text: "\u200Bkeep" }],
    };
    vi.mocked(updateDocuments).mockImplementation((async (_id: string, change: (documents: DocumentUnits, tx: never) => Promise<unknown>) => change(documents, undefined as never)) as never);
    await cleanDocumentText("app1");
    expect(updateDocuments).toHaveBeenCalledWith("app1", expect.any(Function));
    // A bullet keeps its "1.", a line of invisible characters goes, so does a "-" the normaliser uncovered, and an empty line between paragraphs stays.
    expect(documents.RESUME!.map((unit) => unit.text)).toEqual(["Led the finance-portal team ", "1. Platz beim Hackathon\nBuilt it", "Doe, J. (2016). Of\uFB01ce work."]);
    expect(documents.COVER_LETTER![0].text).toBe("A first paragraph\n\nwith a gap");
    expect(documents.EMAIL![0].text).toBe("\u200Bkeep");
  });
});
