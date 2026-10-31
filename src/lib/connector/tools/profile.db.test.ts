import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { saveSettings } from "@/lib/settings-data";
import { createTestClient, resetDatabase } from "@/test/db";

import { seedBuiltIns } from "../../../../prisma/seed/built-ins";
import { seedDemo } from "../../../../prisma/seed/demo";

import { challengeOf, exchangeCode, issueCode, registerClient } from "../oauth";
import { forgetRemovedProfileEntries } from "../removed-entries";

// The profile tools (jobauto fork), called as Claude calls them, through
// /api/mcp, against the test database with the demo data.

const db = vi.hoisted(() => ({ client: undefined as ReturnType<typeof createTestClient> | undefined }));
vi.mock("@/lib/prisma", async () => {
  const { createTestClient } = await import("@/test/db");
  db.client = createTestClient();
  return { prisma: db.client };
});
vi.mock("@/lib/env", () => ({ env: { DOSSIER_SECRET: "s".repeat(40), DOSSIER_PASSWORD: "argon2id:m=19456,t=2,p=1:c2FsdA:aGFzaA" } }));
const fake = vi.hoisted(() => ({ aiUsable: false, provider: "MISTRAL" }));
vi.mock("@/lib/ai/config", () => ({ isAiUsable: async () => fake.aiUsable, loadAiConfig: async () => ({ provider: fake.provider }) }));
// Reading a resume calls the AI model: here the job is only queued.
vi.mock("@/lib/jobs/runner", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/jobs/runner")>()),
  startJob: vi.fn(async (definition: { type: string }, input: object, options: { key?: string } = {}) => {
    const job = await db.client!.job.create({ data: { type: definition.type, key: options.key, input }, select: { id: true } });
    return job.id;
  }),
}));

import { POST } from "@/app/api/mcp/route";

const prisma = () => db.client!;
const CLAUDE = "https://claude.ai/api/mcp/auth_callback";
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
/** The start of a JPEG is enough for a photo Dossier keeps. */
const JPEG = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD";

type Entry = { id: string } & Record<string, unknown>;
type Profile = {
  name: string;
  skills: string[];
  photo: { on_resumes: boolean } | null;
  facts_about_me: { id: string; text: string }[];
  experience: Entry[];
  projects: Entry[];
  education: Entry[];
  publications: Entry[];
  references: Entry[];
};

let token = "";
/** Connects Claude, as signing in from Claude does. */
async function connect(): Promise<void> {
  const clientId = await registerClient({ name: "Claude", redirectUris: [CLAUDE] });
  const verifier = "v".repeat(50);
  const code = await issueCode({ clientId, redirectUri: CLAUDE, codeChallenge: challengeOf(verifier), resource: "" });
  token = (await exchangeCode({ code, clientId, redirectUri: CLAUDE, verifier })).access_token;
}
beforeEach(async () => {
  await resetDatabase(prisma());
  await seedBuiltIns(prisma());
  await seedDemo(prisma(), { now: new Date("2026-10-23T09:00:00Z") });
  await saveSettings({ connectorEnabledAt: "2026-10-23T09:00:00.000Z", strict: false });
  fake.aiUsable = false;
  fake.provider = "MISTRAL";
  // Removals stay in the server's memory from one test to the next.
  forgetRemovedProfileEntries();
  await connect();
});
afterAll(() => prisma().$disconnect());

/** Calls a tool; its text answer, parsed when it's JSON, and whether it's an error. */
async function tool(name: string, args: Record<string, unknown> = {}): Promise<{ isError: boolean; text: string; json: Record<string, unknown> & unknown[] }> {
  const response = await POST(
    new Request("https://dossier.example/api/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18", authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    }),
  );
  const body = await response.text();
  const { result } = JSON.parse(body.trimStart().startsWith("{") ? body : body.split("\n").find((line) => line.startsWith("data: "))!.slice(6));
  const text = result.content[0].text as string;
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    // A plain message.
  }
  return { isError: result.isError ?? false, text, json: json as Record<string, unknown> & unknown[] };
}

const readProfile = async () => (await tool("get_profile")).json as unknown as Profile;
const fields = async () => Object.fromEntries((await prisma().profileField.findMany()).map((row) => [row.key, row.value]));
const ids = (entries: Entry[]) => entries.map((entry) => entry.id);

describe("reading the profile", () => {
  it("gives the profile with ids to edit by, but no contact details, links, or references' email and phone", async () => {
    const { text, json } = await tool("get_profile");
    expect(json).toMatchObject({
      name: "Jane Doe",
      headline: "Senior Product Designer",
      based_in: "Rotterdam, Netherlands",
      contact_details: { email: true, phone: true, address: true, city: true, country: true, website: true, linkedin: true, date_of_birth: true },
      show_age: false,
      photo: null,
      skills: expect.arrayContaining(["Figma", "Design systems"]),
      languages: expect.arrayContaining([{ name: "German", level: "B1" }]),
      facts_about_me: [{ id: expect.any(String), text: expect.stringContaining("user research") }, expect.anything()],
      link: "https://dossier.example/profile",
    });
    const northwind = await prisma().experience.findFirstOrThrow({ where: { company: "Northwind Logistics" } });
    expect(json.experience).toContainEqual(
      expect.objectContaining({ id: northwind.id, role: "Senior Product Designer", start: "2021-03", current: true, skills: expect.arrayContaining(["Design systems"]) }),
    );
    expect(json.projects).toEqual([expect.objectContaining({ name: "Tidewater design tokens", has_link: true })]);
    expect(json.publications).toEqual([expect.objectContaining({ citation: expect.stringContaining("**Doe, J.**"), has_link: true, on_resumes: true })]);
    expect(json.references).toEqual([{ id: expect.any(String), name: "John Doe", relation: "Former manager", company: "Northwind Logistics", has_email: true, has_phone: false }]);
    for (const left of ["jane.doe@example.com", "+31 6 1234 5678", "Westersingel", "1992-04-18", "linkedin.com/in", "john.doe@example.com", "github.com/janedoe", "doi.org"]) {
      expect(text).not.toContain(left);
    }
  });
});

describe("changing the basics", () => {
  it("changes only the fields given and says which changed, without their values", async () => {
    const answer = await tool("update_profile_basics", { name: "Jane Doe", headline: "Lead Product Designer", email: "jane@new.example", phone: "", date_of_birth: "1992-04-19", show_age: true });
    expect(answer.json).toEqual({ changed: ["headline", "email", "phone", "date_of_birth", "show_age"], link: "https://dossier.example/profile?section=basics" });
    expect(answer.text).not.toContain("jane@new.example");
    // A cleared field's row goes, as on the screen.
    expect(await fields()).toMatchObject({ name: "Jane Doe", headline: "Lead Product Designer", email: "jane@new.example", dob: "1992-04-19", showAge: "true", city: "Rotterdam" });
    expect((await fields()).phone).toBeUndefined();

    expect(await tool("update_profile_basics", {})).toMatchObject({ isError: true, text: "Give at least one field to change." });
    expect(await tool("update_profile_basics", { date_of_birth: "19.04.1992" })).toMatchObject({ isError: true });
  });

  it("keeps the photo off resumes or on them, once there is one", async () => {
    expect(await tool("update_profile_basics", { photo_on_resumes: false })).toMatchObject({
      isError: true,
      text: "There's no photo in the profile. The user can add one on the Profile screen.",
    });
    await prisma().profileField.create({ data: { key: "photo", value: PNG } });
    expect((await tool("update_profile_basics", { photo_on_resumes: false })).json).toMatchObject({ changed: ["photo_on_resumes"] });
    expect((await readProfile()).photo).toEqual({ on_resumes: false });
    expect((await tool("update_profile_basics", { photo_on_resumes: false })).json).toMatchObject({ changed: [] });
    await tool("update_profile_basics", { photo_on_resumes: true });
    expect((await fields()).photoOnResumes).toBeUndefined();
  });
});

describe("skills, languages and facts", () => {
  it("adds and removes several at once, in any case, and says what it couldn't find", async () => {
    const answer = await tool("edit_profile_items", {
      add_skills: ["Accessibility", "figma"],
      remove_skills: ["prototyping", "Cobol"],
      set_languages: [
        { name: "german", level: "B2" },
        { name: "Spanish", level: "A2" },
      ],
      remove_languages: ["Dutch", "Klingon"],
      add_facts: ["I have a German work permit."],
    });
    expect(answer.json).toEqual({
      skills: { added: ["Accessibility"], already_there: ["Figma"], removed: ["Prototyping"], not_found: ["Cobol"] },
      languages: { added: ["Spanish"], changed: ["German"], removed: ["Dutch"], not_found: ["Klingon"] },
      facts: { added: [{ id: expect.any(String), text: "I have a German work permit." }] },
      link: "https://dossier.example/profile?section=skills",
    });
    const profile = await readProfile();
    expect(profile.skills).toContain("Accessibility");
    // A removed skill comes off every role too (PRO-3).
    expect(profile.skills).not.toContain("Prototyping");
    expect(profile.experience.flatMap((entry) => entry.skills as string[])).not.toContain("Prototyping");
    expect(await prisma().language.findMany({ select: { name: true, level: true }, orderBy: { sort: "asc" } })).toEqual([
      { name: "English", level: "C2" },
      { name: "German", level: "B2" },
      { name: "Spanish", level: "A2" },
    ]);
    expect(profile.facts_about_me.at(-1)?.text).toBe("I have a German work permit.");

    expect(await tool("edit_profile_items", {})).toMatchObject({ isError: true });
  });

  it("changes and removes the profile's facts by id, but not an application's", async () => {
    const [first, second] = (await readProfile()).facts_about_me;
    const ledgerly = await prisma().application.findFirstOrThrow({ where: { company: "Ledgerly" } });
    const theirs = await prisma().fact.create({ data: { applicationId: ledgerly.id, text: "For Ledgerly only" } });
    const answer = await tool("edit_profile_items", { change_facts: [{ id: first.id, text: "I can start in March." }], remove_facts: [second.id, theirs.id] });
    expect(answer.json).toEqual({
      facts: { changed: [first.id], removed: [second.id], not_found: [theirs.id] },
      link: "https://dossier.example/profile?section=facts",
    });
    expect((await readProfile()).facts_about_me).toEqual([{ id: first.id, text: "I can start in March." }]);
    expect(await prisma().fact.count({ where: { id: theirs.id } })).toBe(1);
  });

  it("stops adding facts at 50", async () => {
    await prisma().fact.createMany({ data: Array.from({ length: 47 }, (_, sort) => ({ text: `Fact ${sort}`, sort: sort + 10 })) });
    const answer = await tool("edit_profile_items", { add_facts: ["One more", "And another"] });
    expect(answer.json).toMatchObject({
      facts: { added: [{ text: "One more" }], not_added: { facts: ["And another"], because: "That's 50 facts already. Remove one you no longer need first." } },
    });
  });
});

describe("saving entries", () => {
  it("adds a role with its dates and skills, then changes only the fields given", async () => {
    const added = await tool("save_profile_entry", {
      experience: { role: "Design Lead", company: "Acme", location: "Berlin", start: "2024-01", current: true, bullets: ["Leads the design team", "Runs research"], skills: ["Figma", "Service design"] },
    });
    expect(added.json).toMatchObject({
      saved: "experience",
      created: true,
      entry: { role: "Design Lead", company: "Acme", start: "2024-01", end: null, current: true, bullets: ["Leads the design team", "Runs research"], skills: ["Figma", "Service design"] },
      new_skills: ["Service design"],
      link: "https://dossier.example/profile?section=experience",
    });
    const { id } = added.json.entry as Entry;
    // Newest first by date.
    expect(ids((await readProfile()).experience)[0]).toBe(id);

    const changed = await tool("save_profile_entry", { experience: { id, start: "2023", end: "2025-06", current: false, skills: ["figma"] } });
    expect(changed.json).toMatchObject({
      created: false,
      entry: { id, role: "Design Lead", location: "Berlin", start: "2023", end: "2025-06", current: false, bullets: ["Leads the design team", "Runs research"], skills: ["Figma"] },
    });
    expect(changed.json.new_skills).toBeUndefined();
    expect(await prisma().experience.findUniqueOrThrow({ where: { id } })).toMatchObject({ startYear: 2023, startMonth: null, endYear: 2025, endMonth: 6 });

    expect(await tool("save_profile_entry", { experience: { id: "gone", role: "Designer" } })).toMatchObject({
      isError: true,
      text: "There's no such role in the profile. get_profile lists them with their ids.",
    });
    expect(await tool("save_profile_entry", { experience: { role: "Designer" }, project: { name: "Tokens" } })).toMatchObject({ isError: true });
    expect(await tool("save_profile_entry", {})).toMatchObject({ isError: true });
    expect(await tool("save_profile_entry", { experience: { id } })).toMatchObject({ isError: true, text: "Give the role's fields to save." });
    expect(await tool("save_profile_entry", { experience: { role: "Designer", start: "March 2024" } })).toMatchObject({ isError: true });
  });

  it("puts a new role first in an order set by hand, as + Add does", async () => {
    const before = ids((await readProfile()).experience);
    await tool("sort_profile_entries", { section: "experience", ids: before.toReversed() });
    const added = await tool("save_profile_entry", { experience: { role: "Older role", start: "2010" } });
    expect(ids((await readProfile()).experience)).toEqual([(added.json.entry as Entry).id, ...before.toReversed()]);
  });

  it("saves projects, education, publications and references, never echoing links or a reference's email and phone", async () => {
    const project = await tool("save_profile_entry", { project: { name: "Calm payouts", link: "github.com/jane/payouts", start: "2023", bullets: ["Built a prototype"], skills: ["Prototyping"] } });
    expect(project.json).toMatchObject({ saved: "project", entry: { name: "Calm payouts", has_link: true, start: "2023", skills: ["Prototyping"] }, link: "https://dossier.example/profile?section=projects" });
    expect(project.text).not.toContain("github.com/jane/payouts");

    const delft = await prisma().education.findFirstOrThrow({ where: { school: "TU Delft" } });
    const degree = await tool("save_profile_entry", { education: { id: delft.id, notes: "Thesis on trust in automation", end: "" } });
    expect(degree.json.entry).toMatchObject({ degree: "MSc Design for Interaction", notes: "Thesis on trust in automation", start: "2013", end: null });

    const publication = await tool("save_profile_entry", { publication: { citation: "**Doe, J.** (2025). *Calm payouts.*", link: "https://doi.org/10.5555/2", on_resumes: false } });
    expect(publication.json.entry).toMatchObject({ citation: "**Doe, J.** (2025). *Calm payouts.*", has_link: true, on_resumes: false });
    // A new publication goes to the top.
    expect(ids((await readProfile()).publications)[0]).toBe((publication.json.entry as Entry).id);

    const reference = await tool("save_profile_entry", { reference: { name: "Max Mustermann", relation: "Team lead", company: "Acme", email: "max@acme.example", phone: "+49 30 1234" } });
    expect(reference.json.entry).toMatchObject({ name: "Max Mustermann", has_email: true, has_phone: true });
    expect(reference.text).not.toContain("max@acme.example");
    expect(reference.text).not.toContain("+49 30 1234");
    expect(await prisma().reference.findUniqueOrThrow({ where: { id: (reference.json.entry as Entry).id } })).toMatchObject({ email: "max@acme.example", phone: "+49 30 1234" });
  });
});

describe("removing entries", () => {
  const nothingToPutBack = { isError: true, text: "There's nothing to put back for that. Only what this tool removed in the last hour can be." };

  it("removes a role and puts it back in its place, with the skills that still exist", async () => {
    const [northwind, fieldnote, brik] = ids((await readProfile()).experience);
    await tool("sort_profile_entries", { section: "experience", ids: [brik, northwind, fieldnote] });

    const removed = await tool("remove_profile_entry", { kind: "experience", id: northwind });
    expect(removed.json).toMatchObject({ removed: "experience", id: northwind, title: "Senior Product Designer at Northwind Logistics", link: "https://dossier.example/profile?section=experience" });
    expect(await prisma().experience.count({ where: { id: northwind } })).toBe(0);

    await prisma().skill.deleteMany({ where: { name: "Workshop facilitation" } });
    expect((await tool("remove_profile_entry", { kind: "experience", id: northwind, restore: true })).json).toMatchObject({ restored: "experience", id: northwind });
    const experience = (await readProfile()).experience;
    expect(ids(experience)).toEqual([brik, northwind, fieldnote]);
    expect(experience[1].skills).toEqual(["Interaction design", "Design systems", "User research"]);

    expect(await tool("remove_profile_entry", { kind: "experience", id: northwind, restore: true })).toMatchObject({ isError: true });
    expect(await tool("remove_profile_entry", { kind: "experience", id: "gone" })).toMatchObject({
      isError: true,
      text: "There's no such role in the profile. get_profile lists them with their ids.",
    });
    expect(await tool("remove_profile_entry", { kind: "project" })).toMatchObject({ isError: true, text: "Give the entry's id from get_profile." });
  });

  it("puts a publication back in its place, and a reference back with the email and phone Claude never saw", async () => {
    for (const citation of ["Second (2020).", "Third (2024)."]) await tool("save_profile_entry", { publication: { citation } });
    const order = ids((await readProfile()).publications);
    await tool("remove_profile_entry", { kind: "publication", id: order[1] });
    await tool("remove_profile_entry", { kind: "publication", id: order[1], restore: true });
    expect(ids((await readProfile()).publications)).toEqual(order);

    const reference = await prisma().reference.findFirstOrThrow();
    const removed = await tool("remove_profile_entry", { kind: "reference", id: reference.id });
    expect(removed.json).toMatchObject({ removed: "reference", title: "John Doe" });
    expect(removed.text).not.toContain("john.doe@example.com");
    await tool("remove_profile_entry", { kind: "reference", id: reference.id, restore: true });
    expect(await prisma().reference.findUniqueOrThrow({ where: { id: reference.id } })).toMatchObject({ name: "John Doe", email: "john.doe@example.com" });
  });

  it("removes the photo and puts it back as it was", async () => {
    expect(await tool("remove_profile_entry", { kind: "photo" })).toMatchObject({ isError: true, text: "There's no photo in the profile." });
    await prisma().profileField.createMany({ data: [{ key: "photo", value: PNG }, { key: "photoOnResumes", value: "false" }] });
    expect((await tool("remove_profile_entry", { kind: "photo" })).json).toMatchObject({ removed: "photo" });
    expect((await readProfile()).photo).toBeNull();
    expect((await tool("remove_profile_entry", { kind: "photo", restore: true })).json).toMatchObject({ restored: "photo" });
    expect((await readProfile()).photo).toEqual({ on_resumes: false });
  });

  it("doesn't put the photo back over one added since", async () => {
    await prisma().profileField.create({ data: { key: "photo", value: PNG } });
    await tool("remove_profile_entry", { kind: "photo" });
    await prisma().profileField.create({ data: { key: "photo", value: JPEG } });
    expect(await tool("remove_profile_entry", { kind: "photo", restore: true })).toMatchObject({
      isError: true,
      text: "The profile has another photo now, so the removed one can't come back. The user can change the photo on the Profile screen.",
    });
    expect((await fields()).photo).toBe(JPEG);
  });

  it("puts entries back for an hour", async () => {
    const reference = await prisma().reference.findFirstOrThrow();
    const delft = await prisma().education.findFirstOrThrow({ where: { school: "TU Delft" } });
    await tool("remove_profile_entry", { kind: "reference", id: reference.id });
    await tool("remove_profile_entry", { kind: "education", id: delft.id });
    vi.useFakeTimers({ now: Date.now() + 59 * 60_000, toFake: ["Date"] });
    try {
      expect((await tool("remove_profile_entry", { kind: "reference", id: reference.id, restore: true })).json).toMatchObject({ restored: "reference" });
      vi.setSystemTime(Date.now() + 2 * 60_000);
      // Claude's access token lasts an hour too.
      await connect();
      expect(await tool("remove_profile_entry", { kind: "education", id: delft.id, restore: true })).toMatchObject(nothingToPutBack);
    } finally {
      vi.useRealTimers();
    }
    expect(await prisma().education.count({ where: { id: delft.id } })).toBe(0);
  });

  it("forgets what it removed once Claude connects again, as after Delete everything", async () => {
    const reference = await prisma().reference.findFirstOrThrow();
    await tool("remove_profile_entry", { kind: "reference", id: reference.id });
    // Delete everything takes the settings along, which turns the connector off; turning it on again signs Claude out.
    await prisma().setting.deleteMany();
    await saveSettings({ connectorEnabledAt: "2026-10-23T10:00:00.000Z" });
    await connect();
    expect(await tool("remove_profile_entry", { kind: "reference", id: reference.id, restore: true })).toMatchObject(nothingToPutBack);
    expect(await prisma().reference.count()).toBe(0);
  });

  it("forgets every removal when told to, as when all the data is deleted or replaced", async () => {
    const reference = await prisma().reference.findFirstOrThrow();
    await tool("remove_profile_entry", { kind: "reference", id: reference.id });
    forgetRemovedProfileEntries();
    expect(await tool("remove_profile_entry", { kind: "reference", id: reference.id, restore: true })).toMatchObject(nothingToPutBack);
    expect(await prisma().reference.count()).toBe(0);
  });
});

describe("ordering entries (E4-9)", () => {
  it("sets an order by hand, and goes back to date order", async () => {
    const [northwind, fieldnote, brik] = ids((await readProfile()).experience);
    const byHand = await tool("sort_profile_entries", { section: "experience", ids: [brik, fieldnote, northwind] });
    expect(byHand.json).toEqual({
      section: "experience",
      order: "by hand",
      entries: ["UX Designer at Studio Brik", "Product Designer at Fieldnote", "Senior Product Designer at Northwind Logistics"],
      link: "https://dossier.example/profile?section=experience",
    });
    expect((await prisma().setting.findUnique({ where: { key: "experienceOrder" } }))?.value).toBe("manual");

    const byDate = await tool("sort_profile_entries", { section: "experience", by_date: true });
    expect(byDate.json).toMatchObject({ order: "by date", entries: ["Senior Product Designer at Northwind Logistics", "Product Designer at Fieldnote", "UX Designer at Studio Brik"] });
    expect((await prisma().setting.findUnique({ where: { key: "experienceOrder" } }))?.value).toBe("date");
  });

  it("orders publications by hand only, and refuses a list that isn't every entry once", async () => {
    await tool("save_profile_entry", { publication: { citation: "Newer (2024)." } });
    const order = ids((await readProfile()).publications);
    expect((await tool("sort_profile_entries", { section: "publications", ids: order.toReversed() })).json).toMatchObject({ order: "by hand" });
    expect(ids((await readProfile()).publications)).toEqual(order.toReversed());

    expect(await tool("sort_profile_entries", { section: "publications", by_date: true })).toMatchObject({
      isError: true,
      text: "Publications have no dates: give their ids in the order you want.",
    });
    expect(await tool("sort_profile_entries", { section: "publications", ids: [order[0], order[0]] })).toMatchObject({
      isError: true,
      text: "Give the id of every entry in that section once, in the new order. get_profile lists them.",
    });
    expect(await tool("sort_profile_entries", { section: "education" })).toMatchObject({ isError: true });
  });
});

describe("importing from a resume (E4-10)", () => {
  const RESUME = "John Doe\nDesign Lead at Acme Payments, 2021 to now\nLed the redesign of the payout flow for merchants across Europe.";
  const reading = {
    profile: {
      basics: { name: "John Doe", headline: "Design Lead", email: "john@payments.example", phone: "+49 170 1234567", city: "Berlin", country: "Germany" },
      skills: [
        { name: "Figma", found: true },
        { name: "Service design", found: false },
      ],
      languages: [
        { name: "German", level: "C1", levelGiven: true },
        { name: "French", level: "B1", levelGiven: false },
      ],
      experience: [
        {
          role: "Design Lead",
          company: "Acme Payments",
          location: "Berlin",
          bullets: "Led the payout redesign",
          skills: ["Figma"],
          startYear: 2021,
          startMonth: null,
          endYear: null,
          endMonth: null,
          current: true,
          unverified: ["Acme Payments"],
        },
      ],
      education: [],
      references: [{ name: "Erika Musterfrau", relation: "Manager", company: "Acme Payments", email: "erika@payments.example", phone: "", unverified: [] }],
    },
    readWith: "extract-profile@1",
  };
  const done = (createdAt = new Date()) =>
    prisma().job.create({ data: { type: "import-profile", key: "profile-import", status: "DONE", input: { resume: RESUME }, result: reading, createdAt } });

  it("has Dossier's own model read a pasted resume, setting an earlier reading aside", async () => {
    expect(await tool("import_profile_from_resume", { resume_text: RESUME })).toMatchObject({ isError: true, text: expect.stringContaining("save_profile_entry") });

    fake.aiUsable = true;
    const earlier = await done();
    const answer = await tool("import_profile_from_resume", { resume_text: RESUME });
    expect(answer.json).toMatchObject({ task_id: expect.any(String), status: "started", sent_to: "Mistral", next: "Call check_task with this task_id until it's done." });
    const taskId = answer.json.task_id as string;
    expect(answer.json.link).toBe(`https://dossier.example/profile/import?job=${taskId}`);
    expect(await prisma().job.findUniqueOrThrow({ where: { id: taskId } })).toMatchObject({ type: "import-profile", key: "profile-import", input: { resume: RESUME } });
    expect(await prisma().job.count({ where: { id: earlier.id } })).toBe(0);

    expect(await tool("import_profile_from_resume", { resume_text: "John Doe, designer" })).toMatchObject({ isError: true, text: "There's hardly any text in that resume. Paste all of it." });
  });

  it("says where the resume's text went, as the Import screen does", async () => {
    fake.aiUsable = true;
    fake.provider = "LOCAL";
    expect((await tool("import_profile_from_resume", { resume_text: RESUME })).json).toMatchObject({ sent_to: "your own AI server" });
    fake.provider = "OPENAI";
    expect((await tool("import_profile_from_resume", { resume_text: RESUME })).json).toMatchObject({ sent_to: "your AI server" });
  });

  it("shows what was read without contact details, then merges it into the profile", async () => {
    const job = await done();
    const shown = await tool("finish_profile_import", { task_id: job.id });
    expect(shown.json).toMatchObject({
      task_id: job.id,
      found: "1 role, 0 projects, 0 degrees, 2 skills, 2 languages, 1 reference",
      read: {
        name: "John Doe",
        based_in: "Berlin, Germany",
        contact_details: { email: true, phone: true, address: false, city: true, country: true, website: false, linkedin: false, date_of_birth: false },
        skills: ["Figma", "Service design"],
        skills_to_check: ["Service design"],
        languages: [{ name: "German", level: "C1" }, { name: "French", level: "B1", level_given: false }],
        experience: [{ role: "Design Lead", company: "Acme Payments", start: "2021", current: true, check: ["Acme Payments"] }],
        references: [{ name: "Erika Musterfrau", has_email: true, has_phone: false }],
      },
      link: `https://dossier.example/profile/import?job=${job.id}`,
    });
    for (const left of ["john@payments.example", "+49 170", "erika@payments.example"]) expect(shown.text).not.toContain(left);
    // Nothing is in the profile before the user chooses.
    expect((await readProfile()).name).toBe("Jane Doe");

    const merged = await tool("finish_profile_import", { task_id: job.id, choice: "merge" });
    expect(merged.json).toMatchObject({ done: "Added to the profile: 1 role, 0 projects, 0 degrees, 2 skills, 2 languages, 1 reference." });
    const profile = await readProfile();
    expect(profile.name).toBe("John Doe");
    expect(profile.experience).toHaveLength(4);
    expect((await fields()).email).toBe("john@payments.example");
    // The reading goes once it's used, with the resume's text.
    expect(await prisma().job.count({ where: { id: job.id } })).toBe(0);
    expect(await tool("finish_profile_import", { task_id: job.id, choice: "merge" })).toMatchObject({
      isError: true,
      text: "There's no resume reading waiting. Start one with import_profile_from_resume.",
    });
  });

  it("replaces the profile with the latest reading, or sets one aside", async () => {
    await done(new Date("2026-10-20T09:00:00Z"));
    const latest = await done(new Date("2026-10-22T09:00:00Z"));
    expect((await tool("finish_profile_import", { choice: "replace" })).json).toMatchObject({
      task_id: latest.id,
      done: "The profile now holds: 1 role, 0 projects, 0 degrees, 2 skills, 2 languages, 1 reference.",
    });
    const profile = await readProfile();
    expect(ids(profile.experience)).toHaveLength(1);
    expect(profile.skills).toEqual(["Figma", "Service design"]);

    const other = await done();
    expect((await tool("finish_profile_import", { task_id: other.id, choice: "discard" })).json).toMatchObject({ task_id: other.id, discarded: true });
    expect(await prisma().job.count({ where: { id: other.id } })).toBe(0);
  });

  it("says when a reading is still under way, failed, or isn't one", async () => {
    const running = await prisma().job.create({ data: { type: "import-profile", status: "RUNNING", step: "Sorting it into your profile", input: { resume: RESUME } } });
    expect((await tool("finish_profile_import", { task_id: running.id })).json).toMatchObject({ status: "working", step: "Sorting it into your profile" });
    expect(await tool("finish_profile_import", { task_id: running.id, choice: "merge" })).toMatchObject({
      isError: true,
      text: "The resume is still being read. Wait until check_task says it's done.",
    });
    await prisma().job.update({ where: { id: running.id }, data: { status: "FAILED", error: "The model didn't answer." } });
    expect(await tool("finish_profile_import", { task_id: running.id })).toMatchObject({ isError: true, text: "The model didn't answer. Start again with import_profile_from_resume." });

    const posting = await prisma().job.create({ data: { type: "read-posting", status: "DONE", input: {}, result: reading } });
    expect(await tool("finish_profile_import", { task_id: posting.id, choice: "merge" })).toMatchObject({ isError: true });
    expect(await prisma().job.count({ where: { id: posting.id } })).toBe(1);
  });
});
