import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { decryptApiKey, encryptApiKey } from "@/lib/ai/api-key";
import { decryptSecret, encryptSecret, JOB_SOURCE_KEY, TYPESAFE_KEY } from "@/lib/secrets";
import { createTestClient, resetDatabase } from "@/test/db";

import { seedBuiltIns } from "../../prisma/seed/built-ins";
import { seedDemo } from "../../prisma/seed/demo";

import { buildExport, EXPORT_SCHEMA_VERSION, exportSchema } from "./data-export";
import { currentSummary, importExport, parseExport } from "./data-import";

vi.mock("@/lib/env", () => ({ env: { DOSSIER_SECRET: "s".repeat(32) } }));

const client = createTestClient();
const prisma = () => client;
const secret = "s".repeat(32);
const now = new Date(2026, 8, 28, 12);
/** An export as it travels: through JSON and back through the schema. */
const asFile = async (options = {}) => {
  const parsed = parseExport(JSON.stringify(await buildExport(prisma(), { now, ...options })));
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.data;
};
const snapshot = async () => JSON.stringify(await buildExport(prisma(), { now }));

beforeEach(async () => {
  await resetDatabase(prisma());
  await seedBuiltIns(prisma());
  await seedDemo(prisma(), { now });
  await prisma().theme.create({ data: { id: "mine", name: "Mine", headFont: "GEIST", bodyFont: "GEIST", accent: "#224466" } });
  const ledgerly = await prisma().application.findFirstOrThrow({ where: { documents: { some: {} } } });
  await prisma().document.updateMany({ where: { applicationId: ledgerly.id, kind: "RESUME" }, data: { themeId: "mine" } });
  await prisma().note.create({ data: { applicationId: ledgerly.id, body: "Called John." } });
  // A version, so the round trip covers document history (E8-10).
  const resume = await prisma().document.findFirstOrThrow({ where: { applicationId: ledgerly.id, kind: "RESUME" } });
  await prisma().documentVersion.create({ data: { documentId: resume.id, units: resume.units ?? [], cause: "WRITTEN", createdAt: now } });
  await prisma().setting.create({ data: { key: "apiKeyEnc", value: encryptApiKey("sk-current", secret) } });
});
afterAll(() => prisma().$disconnect());

describe("importExport (E10-6)", () => {
  it("restores everything as it was exported", async () => {
    const file = await asFile();
    const before = await snapshot();

    // Things change after the export…
    await prisma().application.deleteMany({ where: { company: "Oaken Studio" } });
    await prisma().project.deleteMany();
    await prisma().fact.deleteMany();
    await prisma().skill.create({ data: { name: "Kubernetes" } });
    await prisma().setting.upsert({ where: { key: "paper" }, create: { key: "paper", value: "LETTER" }, update: { value: "LETTER" } });
    await prisma().theme.create({ data: { id: "later", name: "Later", headFont: "GEIST", bodyFont: "GEIST", accent: "#000000" } });

    // …and the import puts it back exactly, versions included.
    await importExport(prisma(), file);
    expect(await snapshot()).toBe(before);
    expect(await prisma().documentVersion.count()).toBe(1);
    expect(await prisma().theme.count({ where: { builtIn: true } })).toBe(12);
    expect(await prisma().projectSkill.count()).toBe(3);
    expect(await prisma().fact.count()).toBe(3);
  });

  it("keeps the next interview's date, and reads older files without it (E9-9)", async () => {
    const file = await asFile();
    const at = file.applications.find((application) => application.company === "Northstar Health")!.nextInterviewAt;
    expect(at).toBeInstanceOf(Date);
    await importExport(prisma(), file);
    expect(await prisma().application.findFirstOrThrow({ where: { company: "Northstar Health" } })).toMatchObject({ nextInterviewAt: at });

    const older = { ...file, applications: file.applications.map((application) => ({ ...application, nextInterviewAt: undefined })) };
    const parsed = parseExport(JSON.stringify(older));
    if (!parsed.ok) throw new Error(parsed.error);
    await importExport(prisma(), parsed.data);
    expect(await prisma().application.findFirstOrThrow({ where: { company: "Northstar Health" } })).toMatchObject({ nextInterviewAt: null });
  });

  it("keeps skill groups, and reads files from before them as having none (#280)", async () => {
    await prisma().skill.updateMany({ where: { name: "Figma" }, data: { group: "Tools" } });
    const file = await asFile();
    expect(file.profile.skills.find((skill) => skill.name === "Figma")).toMatchObject({ group: "Tools" });
    await importExport(prisma(), file);
    expect(await prisma().skill.findFirstOrThrow({ where: { name: "Figma" } })).toMatchObject({ group: "Tools" });

    const older = { ...file, schemaVersion: 6, profile: { ...file.profile, skills: file.profile.skills.map((skill) => Object.fromEntries(Object.entries(skill).filter(([key]) => key !== "group"))) } };
    const parsed = parseExport(JSON.stringify(older));
    if (!parsed.ok) throw new Error(parsed.error);
    await importExport(prisma(), parsed.data);
    expect(await prisma().skill.findFirstOrThrow({ where: { name: "Figma" } })).toMatchObject({ group: "" });
  });

  it("deletes every background job, since their inputs and results hold the data it replaces", async () => {
    const ledgerly = await prisma().application.findFirstOrThrow({ where: { documents: { some: {} } } });
    await prisma().job.createMany({
      data: [
        { type: "write-email", key: `email:${ledgerly.id}`, applicationId: ledgerly.id, status: "DONE", input: {} },
        { type: "import-profile", key: "profile-import", status: "DONE", input: { resume: "Jane Doe, jane@example.com" } },
        { type: "read-posting", status: "DONE", input: { posting: "A posting never applied to" } },
      ],
    });
    await importExport(prisma(), await asFile());
    expect(await prisma().job.count()).toBe(0);
  });

  it("keeps the current API key when the file has none", async () => {
    await importExport(prisma(), await asFile());
    const saved = await prisma().setting.findUniqueOrThrow({ where: { key: "apiKeyEnc" } });
    expect(decryptApiKey(saved.value, secret)).toBe("sk-current");
  });

  it("keeps this install's own settings, such as the update check's day, whatever the file says", async () => {
    const file = await asFile();
    await prisma().setting.createMany({ data: [{ key: "updateCheckDay", value: "2026-09-28" }] });
    const fromElsewhere = [{ key: "updateCheckDay", value: "2026-01-01" }];
    await importExport(prisma(), { ...file, settings: [...file.settings, ...fromElsewhere] });
    const kept = await prisma().setting.findMany({ where: { key: "updateCheckDay" } });
    expect(kept.map(({ key, value }) => ({ key, value }))).toEqual([{ key: "updateCheckDay", value: "2026-09-28" }]);
  });

  it("saves the file's API key, encrypted for this server", async () => {
    const file = await asFile();
    await importExport(prisma(), { ...file, apiKey: "sk-from-file" });
    const saved = await prisma().setting.findUniqueOrThrow({ where: { key: "apiKeyEnc" } });
    expect(saved.value).not.toContain("sk-from-file");
    expect(decryptApiKey(saved.value, secret)).toBe("sk-from-file");
  });

  it("restores Find jobs' postings with their applications, and leaves a missing one unlinked (E14-9)", async () => {
    const ledgerly = await prisma().application.findFirstOrThrow({ where: { documents: { some: {} } } });
    await prisma().posting.create({ data: { source: "JSEARCH", externalId: "job-1", title: "Designer", savedAt: now, applicationId: ledgerly.id } });
    await prisma().posting.create({ data: { source: "ADZUNA", externalId: "job-2", dismissedAt: now } });
    const file = await asFile();
    expect(file.postings).toHaveLength(2);

    await prisma().posting.deleteMany();
    await importExport(prisma(), file);
    expect(await prisma().posting.findMany({ orderBy: { externalId: "asc" }, select: { externalId: true, applicationId: true, savedAt: true, dismissedAt: true } })).toEqual([
      { externalId: "job-1", applicationId: ledgerly.id, savedAt: now, dismissedAt: null },
      { externalId: "job-2", applicationId: null, savedAt: null, dismissedAt: now },
    ]);

    await importExport(prisma(), { ...file, applications: file.applications.filter((application) => application.id !== ledgerly.id) });
    expect(await prisma().posting.findFirstOrThrow({ where: { externalId: "job-1" } })).toMatchObject({ applicationId: null });
  });

  it("restores the recruiters with their history, and reads a file from before there were any", async () => {
    await prisma().recruiter.create({
      data: {
        id: "rec-1",
        name: "Selby Jennings",
        email: "jobs@example.com",
        status: "CONTACTED",
        contactedAt: now,
        followUpAt: new Date(now.getTime() + 7 * 86_400_000),
        events: { create: [{ id: "ev-1", text: "Added", at: now }, { id: "ev-2", text: "Marked as contacted", at: now }] },
      },
    });
    await prisma().recruiterBlock.create({ data: { key: "adecco", createdAt: now } });
    const file = await asFile();
    expect(file.recruiterBlocks).toEqual([{ key: "adecco", createdAt: now }]);
    expect(file.recruiters).toMatchObject([{ id: "rec-1", name: "Selby Jennings", events: [{ text: "Added" }, { text: "Marked as contacted" }] }]);
    await prisma().recruiter.deleteMany();
    await prisma().recruiterBlock.deleteMany();
    await importExport(prisma(), file);
    expect(await prisma().recruiterBlock.findMany()).toMatchObject([{ key: "adecco" }]);
    expect(await prisma().recruiter.findUniqueOrThrow({ where: { id: "rec-1" }, include: { events: { orderBy: { id: "asc" } } } })).toMatchObject({
      name: "Selby Jennings",
      email: "jobs@example.com",
      status: "CONTACTED",
      contactedAt: now,
      events: [{ id: "ev-1", text: "Added" }, { id: "ev-2", text: "Marked as contacted" }],
    });

    // Last night's kind of file has no recruiters: they read as none, and an import clears the ones there.
    const older = parseExport(JSON.stringify({ ...file, schemaVersion: 5, recruiters: undefined, recruiterBlocks: undefined }));
    expect(older).toMatchObject({ ok: true, data: { schemaVersion: 5, recruiters: [] } });
    await importExport(prisma(), older.ok ? older.data : file);
    expect(await prisma().recruiter.count()).toBe(0);
    expect(await prisma().recruiterBlock.count()).toBe(0);
  });

  it("restores past searches with what they found (E14-10)", async () => {
    await prisma().postingSearch.create({
      data: { sources: ["JSEARCH", "SERPAPI"], query: { keywords: "designer" }, postings: [{ externalId: "job-1" }], found: 1, cursors: { JSEARCH: "cursor:2" }, createdAt: now },
    });
    const file = await asFile();
    expect(file.searches).toHaveLength(1);
    await prisma().postingSearch.deleteMany();
    await importExport(prisma(), file);
    expect(await prisma().postingSearch.findFirstOrThrow()).toMatchObject({
      sources: ["JSEARCH", "SERPAPI"],
      query: { keywords: "designer" },
      postings: [{ externalId: "job-1" }],
      found: 1,
      cursors: { JSEARCH: "cursor:2" },
      problems: [],
      createdAt: now,
    });

    // A file from before searches of several sources: one source and its next page.
    await prisma().postingSearch.deleteMany();
    const { sources, cursors, problems, ...older } = file.searches[0];
    void sources;
    void cursors;
    void problems;
    await importExport(prisma(), { ...file, searches: [{ ...older, source: "JSEARCH", next: "cursor:9" }] });
    expect(await prisma().postingSearch.findFirstOrThrow()).toMatchObject({ sources: ["JSEARCH"], cursors: { JSEARCH: "cursor:9" }, problems: [] });
  });

  it("reads the fork's own version 6 files from before the merge: recruiters and several sources, without upstream's 6 to 11 (bewerbung fork)", async () => {
    await prisma().recruiter.create({ data: { id: "rec-1", name: "Hays", events: { create: { id: "ev-1", text: "Added", at: now } } } });
    await prisma().postingSearch.create({ data: { sources: ["JSEARCH", "JOOBLE"], query: { keywords: "designer" }, postings: [], cursors: { JOOBLE: "2" }, createdAt: now } });
    const file = await asFile();
    expect(file.schemaVersion).toBe(EXPORT_SCHEMA_VERSION);
    // What the fork wrote as 6: its additions, the job agent's one search as a setting, and nothing upstream added after 5.
    const forkSix = {
      ...file,
      schemaVersion: 6,
      settings: [...file.settings, { key: "agentQuery", value: JSON.stringify({ keywords: "Product designer", place: "Berlin", country: "de" }) }],
      profile: {
        ...file.profile,
        skills: file.profile.skills.map((skill) => ({ ...skill, group: undefined })),
        experience: file.profile.experience.map((entry) => ({ ...entry, descriptor: undefined, volunteering: undefined })),
        certifications: undefined,
        customSections: undefined,
      },
      applications: file.applications.map((application) => ({ ...application, boardSort: undefined, sections: undefined, frozen: undefined, resumeFit: undefined })),
      agentSearches: undefined,
      agentCandidateSearches: undefined,
    };
    const parsed = parseExport(JSON.stringify(forkSix));
    if (!parsed.ok) throw new Error(parsed.error);
    await prisma().recruiter.deleteMany();
    await prisma().postingSearch.deleteMany();
    await importExport(prisma(), parsed.data);
    expect(await prisma().recruiter.findUniqueOrThrow({ where: { id: "rec-1" }, include: { events: true } })).toMatchObject({ name: "Hays", events: [{ text: "Added" }] });
    expect(await prisma().postingSearch.findFirstOrThrow()).toMatchObject({ sources: ["JSEARCH", "JOOBLE"], cursors: { JOOBLE: "2" } });
    expect(await prisma().agentSearch.findMany()).toMatchObject([{ name: "My search", query: { keywords: "Product designer", country: "de" } }]);
    expect(await prisma().setting.count({ where: { key: "agentQuery" } })).toBe(0);
  });

  it("restores the job agent's candidates and drafts, so what it saw stays seen (E16)", async () => {
    const draft = await prisma().application.create({ data: { title: "Agent draft", origin: "AGENT", agentScore: 88, awaitingReview: true } });
    await prisma().agentCandidate.create({
      data: { source: "JSEARCH", externalId: "job-1", title: "Data Scientist", score: 88, reasons: ["Python"], status: "DRAFTED", applicationId: draft.id, dedupeKey: "key-1" },
    });
    await prisma().agentCandidate.create({ data: { source: "ADZUNA", externalId: "az-1", title: "Gone", status: "DISMISSED", dedupeKey: "key-2" } });
    const file = await asFile();
    expect(file.agentCandidates).toHaveLength(2);
    expect(file.applications.find((application) => application.id === draft.id)).toMatchObject({ origin: "AGENT", agentScore: 88, awaitingReview: true });

    await prisma().agentCandidate.deleteMany();
    // A score is made again from the profile, so it's neither exported nor kept by an import (#208).
    await prisma().postingScore.create({ data: { source: "JSEARCH", externalId: "job-1", score: 80, reasons: [], redFlags: [], scoredWith: "score-posting@1" } });
    expect(JSON.stringify(file)).not.toContain("scoredWith");
    await importExport(prisma(), file);
    expect(await prisma().postingScore.count()).toBe(0);
    expect(await prisma().agentCandidate.findMany({ orderBy: { externalId: "asc" }, select: { externalId: true, status: true, applicationId: true, reasons: true } })).toEqual([
      { externalId: "az-1", status: "DISMISSED", applicationId: null, reasons: null },
      { externalId: "job-1", status: "DRAFTED", applicationId: draft.id, reasons: ["Python"] },
    ]);
    expect(await prisma().application.findUniqueOrThrow({ where: { id: draft.id } })).toMatchObject({ origin: "AGENT", awaitingReview: true });

    // Files from before the agent have none, and their applications are the user's own.
    const older = JSON.parse(JSON.stringify(file));
    delete older.agentCandidates;
    for (const application of older.applications) for (const key of ["origin", "agentScore", "awaitingReview"]) delete application[key];
    const parsed = parseExport(JSON.stringify(older));
    expect(parsed).toMatchObject({ ok: true, data: { agentCandidates: [] } });
    if (!parsed.ok) return;
    await importExport(prisma(), parsed.data);
    expect(await prisma().agentCandidate.count()).toBe(0);
    expect(await prisma().application.findUniqueOrThrow({ where: { id: draft.id } })).toMatchObject({ origin: "MANUAL", awaitingReview: false });
  });

  it("restores Startups with what the user did with them, and reads files from before them as having none (#222)", async () => {
    const application = await prisma().application.create({ data: { title: "Android · Acme" } });
    const emails = [{ email: "jobs@acme.example", label: "Hiring", from: "https://acme.example/careers", onRequest: false, foundAt: "2026-10-01T00:00:00.000Z" }];
    await prisma().startup.create({
      data: { source: "HN", externalId: "1", company: "Acme", roles: ["Engineer"], emails, links: [], reasons: ["In Berlin"], status: "SAVED", notes: "Ask about Compose", applicationId: application.id },
    });
    await prisma().startup.create({ data: { source: "YC", externalId: "2", company: "Gone", roles: [], emails: [], links: [], reasons: [], status: "DISMISSED" } });
    await prisma().startupBlock.create({ data: { hash: "b".repeat(64) } });
    const select = { externalId: true, status: true, notes: true, emails: true, roles: true, applicationId: true } as const;
    const before = await prisma().startup.findMany({ orderBy: { externalId: "asc" }, select });
    const file = await asFile();
    expect(file.startups).toHaveLength(2);

    await importExport(prisma(), file);
    expect(await prisma().startup.findMany({ orderBy: { externalId: "asc" }, select })).toEqual(before);
    expect(await prisma().startupBlock.count()).toBe(1);

    // An application that isn't in the file leaves its startup unlinked; older files have no startups.
    const unlinked = JSON.parse(JSON.stringify(file));
    unlinked.applications = unlinked.applications.filter((entry: { id: string }) => entry.id !== application.id);
    await importExport(prisma(), exportSchema.parse(unlinked));
    expect((await prisma().startup.findFirstOrThrow({ where: { externalId: "1" } })).applicationId).toBeNull();
    const older = JSON.parse(JSON.stringify(file));
    delete older.startups;
    delete older.startupBlocks;
    const parsed = parseExport(JSON.stringify(older));
    expect(parsed).toMatchObject({ ok: true, data: { startups: [], startupBlocks: [] } });
    if (!parsed.ok) return;
    await importExport(prisma(), parsed.data);
    expect(await prisma().startup.count()).toBe(0);
  });

  it("reads files from before projects as having none (PRO-13)", async () => {
    const file = JSON.parse(JSON.stringify(await buildExport(prisma(), { now })));
    const parsed = parseExport(JSON.stringify({ ...file, schemaVersion: 2, profile: { ...file.profile, projects: undefined } }));
    expect(parsed).toMatchObject({ ok: true, data: { schemaVersion: 2, profile: { projects: [] } } });
    if (!parsed.ok) return;
    await importExport(prisma(), parsed.data);
    expect(await prisma().project.count()).toBe(0);
  });

  it("restores publications, and reads files from before them as having none (#218)", async () => {
    await prisma().publication.updateMany({ data: { onResumes: false } });
    const file = JSON.parse(JSON.stringify(await buildExport(prisma(), { now })));
    const before = await prisma().publication.findMany();
    await importExport(prisma(), exportSchema.parse(file));
    expect(await prisma().publication.findMany()).toEqual(before);

    const parsed = parseExport(JSON.stringify({ ...file, schemaVersion: 4, profile: { ...file.profile, publications: undefined } }));
    expect(parsed).toMatchObject({ ok: true, data: { schemaVersion: 4, profile: { publications: [] } } });
    if (!parsed.ok) return;
    await importExport(prisma(), parsed.data);
    expect(await prisma().publication.count()).toBe(0);
  });

  it("restores custom sections, an application's own order and what it was sent with, and reads files from before them as having none (#297, #298, #299)", async () => {
    await prisma().customSection.create({ data: { id: "s1", title: "Awards", format: "LINES", items: { create: [{ id: "i1", title: "Best Paper", link: "example.org", sort: 0 }] } } });
    const application = await prisma().application.findFirstOrThrow();
    const frozen = { profile: { basics: { name: "As sent" } }, themes: { RESUME: null, COVER_LETTER: null }, paper: "A4", dateFormat: "NUMERIC", includeReferences: false, followedBase: false };
    await prisma().application.update({ where: { id: application.id }, data: { sections: { order: ["skills"], off: ["custom:s1"] }, frozen } });
    const file = await asFile();
    const sections = await prisma().customSection.findMany({ include: { items: true } });
    await importExport(prisma(), file);
    expect(await prisma().customSection.findMany({ include: { items: true } })).toEqual(sections);
    expect(await prisma().application.findUniqueOrThrow({ where: { id: application.id } })).toMatchObject({ sections: { order: ["skills"], off: ["custom:s1"] }, frozen });

    const parsed = parseExport(JSON.stringify({ ...file, schemaVersion: 8, profile: { ...file.profile, customSections: undefined } }));
    expect(parsed).toMatchObject({ ok: true, data: { schemaVersion: 8, profile: { customSections: [] } } });
  });

  it("restores certifications, and reads files from before them as having none (#293)", async () => {
    await prisma().certification.updateMany({ data: { onResumes: false } });
    const file = JSON.parse(JSON.stringify(await buildExport(prisma(), { now })));
    const before = await prisma().certification.findMany();
    await importExport(prisma(), exportSchema.parse(file));
    expect(await prisma().certification.findMany()).toEqual(before);

    const parsed = parseExport(JSON.stringify({ ...file, schemaVersion: 7, profile: { ...file.profile, certifications: undefined } }));
    expect(parsed).toMatchObject({ ok: true, data: { schemaVersion: 7, profile: { certifications: [] } } });
    if (!parsed.ok) return;
    await importExport(prisma(), parsed.data);
    expect(await prisma().certification.count()).toBe(0);
  });

  it("restores the line about each role's company, and reads files from before it with none (#257)", async () => {
    const file = JSON.parse(JSON.stringify(await buildExport(prisma(), { now })));
    const lines = async () => (await prisma().experience.findMany({ orderBy: { sort: "asc" } })).map((entry) => entry.descriptor);
    const before = await lines();
    expect(before).toContain("Freight platform for European carriers, 300 people");
    await importExport(prisma(), exportSchema.parse(file));
    expect(await lines()).toEqual(before);

    // undefined: left out of the JSON, as in a file from before it.
    const experience = file.profile.experience.map((entry: object) => ({ ...entry, descriptor: undefined }));
    const parsed = parseExport(JSON.stringify({ ...file, schemaVersion: 5, profile: { ...file.profile, experience } }));
    if (!parsed.ok) throw new Error(parsed.error);
    await importExport(prisma(), parsed.data);
    expect(await lines()).toEqual(before.map(() => ""));
  });

  it("restores which roles are volunteering, and reads files from before it with paid roles only (#294)", async () => {
    const [first] = await prisma().experience.findMany({ orderBy: { sort: "asc" } });
    await prisma().experience.update({ where: { id: first.id }, data: { volunteering: true } });
    const file = JSON.parse(JSON.stringify(await buildExport(prisma(), { now })));
    const marks = async () => (await prisma().experience.findMany({ orderBy: { sort: "asc" } })).map((entry) => entry.volunteering);
    const before = await marks();
    expect(before.filter(Boolean)).toHaveLength(1);
    await importExport(prisma(), exportSchema.parse(file));
    expect(await marks()).toEqual(before);

    const experience = file.profile.experience.map((entry: object) => ({ ...entry, volunteering: undefined }));
    const parsed = parseExport(JSON.stringify({ ...file, schemaVersion: 7, profile: { ...file.profile, experience } }));
    if (!parsed.ok) throw new Error(parsed.error);
    await importExport(prisma(), parsed.data);
    expect(await marks()).toEqual(before.map(() => false));
  });

  it("restores the photo, the themes' photo options and each application's Photo switch, and reads older files with the defaults (#224)", async () => {
    const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
    await prisma().profileField.createMany({ data: [{ key: "photo", value: png }, { key: "photoOnResumes", value: "false" }] });
    await prisma().theme.update({ where: { id: "mine" }, data: { photoShape: "PORTRAIT", photoPosition: "SIDEBAR" } });
    await prisma().application.updateMany({ where: { company: "Ledgerly" }, data: { showPhoto: true } });
    const file = JSON.parse(JSON.stringify(await buildExport(prisma(), { now })));

    await prisma().profileField.deleteMany({ where: { key: { startsWith: "photo" } } });
    await importExport(prisma(), exportSchema.parse(file));
    const fields = await prisma().profileField.findMany({ where: { key: { startsWith: "photo" } }, orderBy: { key: "asc" } });
    expect(fields.map(({ key, value }) => [key, value])).toEqual([["photo", png], ["photoOnResumes", "false"]]);
    expect(await prisma().theme.findUniqueOrThrow({ where: { id: "mine" } })).toMatchObject({ photoShape: "PORTRAIT", photoPosition: "SIDEBAR" });
    expect(await prisma().application.findFirstOrThrow({ where: { company: "Ledgerly" } })).toMatchObject({ showPhoto: true });

    const older = {
      ...file,
      themes: file.themes.map((theme: object) => ({ ...theme, photoShape: undefined, photoPosition: undefined })),
      applications: file.applications.map((application: object) => ({ ...application, showPhoto: undefined })),
    };
    await importExport(prisma(), exportSchema.parse(older));
    expect(await prisma().theme.findUniqueOrThrow({ where: { id: "mine" } })).toMatchObject({ photoShape: "CIRCLE", photoPosition: "HEADER_END" });
    expect(await prisma().application.findFirstOrThrow({ where: { company: "Ledgerly" } })).toMatchObject({ showPhoto: null });
  });

  it("restores the board's order, and reads older files as newest first (public issue 60)", async () => {
    await prisma().application.updateMany({ where: { company: "Ledgerly" }, data: { boardSort: 4 } });
    const file = JSON.parse(JSON.stringify(await buildExport(prisma(), { now })));

    await importExport(prisma(), exportSchema.parse(file));
    expect(await prisma().application.findFirstOrThrow({ where: { company: "Ledgerly" } })).toMatchObject({ boardSort: 4 });

    const older = { ...file, applications: file.applications.map((application: object) => ({ ...application, boardSort: undefined })) };
    await importExport(prisma(), exportSchema.parse(older));
    expect(await prisma().application.findFirstOrThrow({ where: { company: "Ledgerly" } })).toMatchObject({ boardSort: null });
  });

  it("reads files from before facts, with an application's note as its first fact (PRO-14, APP-15)", async () => {
    const file = JSON.parse(JSON.stringify(await buildExport(prisma(), { now })));
    const [first, ...rest] = file.applications;
    const old = {
      ...file,
      schemaVersion: 3,
      profile: { ...file.profile, facts: undefined },
      applications: [
        { ...first, facts: undefined, userNote: "  Relocating in January.  " },
        ...rest.map((application: object) => ({ ...application, facts: undefined, userNote: "" })),
      ],
    };
    const parsed = parseExport(JSON.stringify(old));
    expect(parsed).toMatchObject({ ok: true, data: { schemaVersion: 3, profile: { facts: [] } } });
    if (!parsed.ok) return;
    await importExport(prisma(), parsed.data);
    expect(await prisma().fact.findMany({ select: { applicationId: true, text: true } })).toEqual([{ applicationId: first.id, text: "Relocating in January." }]);
  });

  it("reads version 1 files, which have no postings", async () => {
    const file = JSON.parse(JSON.stringify(await buildExport(prisma(), { now })));
    const parsed = parseExport(JSON.stringify({ ...file, schemaVersion: 1, postings: undefined, searches: undefined }));
    expect(parsed).toMatchObject({ ok: true, data: { schemaVersion: 1, postings: [], searches: [] } });
  });

  it("keeps saved job source keys the file doesn't carry, and saves the ones it does, encrypted (E14-9)", async () => {
    await prisma().setting.createMany({
      data: [
        { key: "jsearchKeyEnc", value: encryptSecret(JOB_SOURCE_KEY, "ak-current", secret) },
        { key: "adzunaKeyEnc", value: encryptSecret(JOB_SOURCE_KEY, "adz-current", secret) },
      ],
    });
    const file = await asFile();
    expect(file.settings.map((setting) => setting.key)).not.toContain("jsearchKeyEnc");

    await importExport(prisma(), { ...file, jobSourceKeys: { jsearch: "ak-from-file" } });
    const value = async (key: string) => decryptSecret(JOB_SOURCE_KEY, (await prisma().setting.findUniqueOrThrow({ where: { key } })).value, secret);
    expect(await value("jsearchKeyEnc")).toBe("ak-from-file");
    expect(await value("adzunaKeyEnc")).toBe("adz-current");
    expect(decryptApiKey((await prisma().setting.findUniqueOrThrow({ where: { key: "apiKeyEnc" } })).value, secret)).toBe("sk-current");
  });

  it("never exports the TypeSafe key, and keeps this server's on import (#274)", async () => {
    await prisma().setting.createMany({
      data: [
        { key: "typesafeKeyEnc", value: encryptSecret(TYPESAFE_KEY, "ts-current", secret) },
        { key: "scorer", value: "JEV" },
      ],
    });
    // Not even with the keys asked for: the TypeSafe key belongs to this server.
    const file = await asFile({ includeApiKey: true });
    expect(file.settings.map((setting) => setting.key)).not.toContain("typesafeKeyEnc");
    expect(file.settings).toContainEqual({ key: "scorer", value: "JEV" });
    expect(JSON.stringify(file)).not.toContain("ts-current");

    await importExport(prisma(), { ...file, settings: file.settings.filter((setting) => setting.key !== "scorer") });
    const kept = await prisma().setting.findUniqueOrThrow({ where: { key: "typesafeKeyEnc" } });
    expect(decryptSecret(TYPESAFE_KEY, kept.value, secret)).toBe("ts-current");
    expect(await prisma().setting.findUnique({ where: { key: "scorer" } })).toBeNull();
  });

  it("points documents at the base theme when their theme isn't in the file", async () => {
    const file = await asFile();
    await importExport(prisma(), { ...file, themes: [] });
    expect(await prisma().document.count({ where: { themeId: "mine" } })).toBe(0);
  });

  it("changes nothing when the import fails halfway", async () => {
    const file = await asFile();
    const before = await snapshot();
    const [first] = file.applications;
    // Two applications with the same ID: the database refuses the second.
    await expect(importExport(prisma(), { ...file, applications: [...file.applications, { ...first, events: [], documents: [], messages: [], notes: [] }] })).rejects.toThrow();
    expect(await snapshot()).toBe(before);
  });

  it("counts what's there", async () => {
    expect(await currentSummary(prisma())).toEqual({ applications: 9, roles: 3, skills: 7, themes: 1, notes: 1 });
  });
});

describe("parseExport (E10-6)", () => {
  it("explains what's wrong with a file", async () => {
    const good = JSON.parse(JSON.stringify(await buildExport(prisma(), { now })));
    expect(parseExport("not json")).toEqual({ ok: false, error: "That file isn't a Dossier export: it isn't JSON." });
    expect(parseExport(JSON.stringify({ hello: "world" }))).toEqual({ ok: false, error: "That file isn't a Dossier export." });
    expect(parseExport(JSON.stringify({ ...good, schemaVersion: EXPORT_SCHEMA_VERSION + 1 }))).toEqual({
      ok: false,
      error: `That export comes from a newer version of Dossier (schema ${EXPORT_SCHEMA_VERSION + 1}). Update this server first.`,
    });
    expect(parseExport(JSON.stringify({ ...good, schemaVersion: 0 }))).toMatchObject({ ok: false, error: expect.stringMatching(/isn't one this version/) });
    const damaged = { ...good, applications: [{ ...good.applications[0], status: "MAYBE" }] };
    expect(parseExport(JSON.stringify(damaged))).toMatchObject({ ok: false, error: expect.stringMatching(/^That export is damaged or incomplete \(applications\.0\.status/) });
  });
});
