import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { saveSettings } from "@/lib/settings-data";
import { createTestClient, resetDatabase } from "@/test/db";

import { seedBuiltIns } from "../../../../prisma/seed/built-ins";
import { seedDemo } from "../../../../prisma/seed/demo";

import { challengeOf, exchangeCode, issueCode, registerClient } from "../oauth";

// The applications area's tools (jobauto fork), called as Claude calls them,
// through /api/mcp, against the test database with the demo data.

const db = vi.hoisted(() => ({ client: undefined as ReturnType<typeof createTestClient> | undefined }));
vi.mock("@/lib/prisma", async () => {
  const { createTestClient } = await import("@/test/db");
  db.client = createTestClient();
  return { prisma: db.client };
});
vi.mock("@/lib/env", () => ({ env: { DOSSIER_SECRET: "s".repeat(40), DOSSIER_PASSWORD: "argon2id:m=19456,t=2,p=1:c2FsdA:aGFzaA" } }));
const fake = vi.hoisted(() => ({ ai: true }));
vi.mock("@/lib/ai/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ai/config")>()),
  isAiConfigured: async () => fake.ai,
  isAiUsable: async () => fake.ai,
}));
// The calendar's side is tested in src/lib/google; here it's off unless a test says otherwise.
const calendar = vi.hoisted(() => ({
  sync: vi.fn<(id: string) => Promise<{ inCalendar: boolean; eventLink: string | null }>>(async () => ({ inCalendar: false, eventLink: null })),
}));
vi.mock("@/lib/google/availability", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/google/availability")>()),
  syncInterviewToCalendar: calendar.sync,
}));
// An apply run's PDFs and screenshots are files in the data directory; here deleting them is only recorded.
const { deleteApplyRuns } = vi.hoisted(() => ({ deleteApplyRuns: vi.fn<(attemptIds: readonly string[]) => Promise<void>>(async () => {}) }));
vi.mock("@/lib/apply/files", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/apply/files")>()), deleteApplyRuns }));
// Jobs are queued for real, but don't run.
vi.mock("@/lib/jobs/runner", async (importOriginal) => {
  const runner = await importOriginal<typeof import("@/lib/jobs/runner")>();
  return {
    ...runner,
    startJob: vi.fn(async (definition: { type: string }, input: object, options: { key?: string; applicationId?: string } = {}) => {
      const { prisma } = await import("@/lib/prisma");
      return (await prisma.job.create({ data: { type: definition.type, input, key: options.key, applicationId: options.applicationId } })).id;
    }),
  };
});

import { POST } from "@/app/api/mcp/route";

const prisma = () => db.client!;
const CLAUDE = "https://claude.ai/api/mcp/auth_callback";

let token = "";
beforeEach(async () => {
  await resetDatabase(prisma());
  await seedBuiltIns(prisma());
  await seedDemo(prisma(), { now: new Date("2026-10-23T09:00:00Z") });
  // Times without an offset are read in the zone the browser last told the server.
  await saveSettings({ connectorEnabledAt: "2026-10-23T09:00:00.000Z", strict: false, browserTimeZone: "Europe/Berlin" });
  fake.ai = true;
  calendar.sync.mockClear();
  deleteApplyRuns.mockClear();
  const clientId = await registerClient({ name: "Claude", redirectUris: [CLAUDE] });
  const verifier = "v".repeat(50);
  const code = await issueCode({ clientId, redirectUri: CLAUDE, codeChallenge: challengeOf(verifier), resource: "" });
  token = (await exchangeCode({ code, clientId, redirectUri: CLAUDE, verifier })).access_token;
});
afterAll(() => prisma().$disconnect());

/** Sends one request to /api/mcp as Claude does; its result. */
async function rpc(method: string, params: Record<string, unknown>) {
  const response = await POST(
    new Request("https://dossier.example/api/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18", authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }),
  );
  const body = await response.text();
  return JSON.parse(body.trimStart().startsWith("{") ? body : body.split("\n").find((line) => line.startsWith("data: "))!.slice(6)).result;
}

/** Calls a tool; its text answer, parsed when it's JSON, and whether it's an error. */
async function tool(name: string, args: Record<string, unknown> = {}): Promise<{ isError: boolean; text: string; json: Record<string, unknown> & unknown[] }> {
  const result = await rpc("tools/call", { name, arguments: args });
  const text = result.content[0].text as string;
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    // A plain message.
  }
  return { isError: result.isError ?? false, text, json: json as Record<string, unknown> & unknown[] };
}

const application = (company: string) => prisma().application.findFirstOrThrow({ where: { company } });
const saved = (id: string) => prisma().application.findUniqueOrThrow({ where: { id } });

describe("the applications area's tools (jobauto fork)", () => {
  it("offers its tools, with hints that say what they change", async () => {
    const { tools } = (await rpc("tools/list", {})) as { tools: { name: string; annotations?: Record<string, boolean> }[] };
    const hints = Object.fromEntries(tools.map((entry) => [entry.name, entry.annotations]));
    expect(hints.list_notes).toEqual({ readOnlyHint: true, openWorldHint: false });
    expect(hints.save_note).toEqual({ readOnlyHint: false, destructiveHint: true, openWorldHint: false });
    // Removing a fact can't be undone, and the interview date goes to Google Calendar when Dossier keeps interviews there.
    expect(hints.update_application).toEqual({ readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true });
    expect(hints.delete_application).toEqual({ readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false });
    // The change undone leaves the history, with the date it was made.
    expect(hints.undo_status_change).toEqual({ readOnlyHint: false, destructiveHint: true, openWorldHint: false });
    // The email is written by the AI provider set up in Dossier.
    expect(hints.write_application_email).toEqual({ readOnlyHint: false, destructiveHint: false, openWorldHint: true });
  });

  it("adds, reads, changes and deletes a private note", async () => {
    const ledgerly = await application("Ledgerly");
    const added = await tool("save_note", { id: ledgerly.id, body: "  Called John; second round next week.  " });
    expect(added.json).toMatchObject({ added: true, note_id: expect.any(String), link: `https://dossier.example/applications/${ledgerly.id}?tab=notes` });
    const noteId = added.json.note_id as string;
    expect((await prisma().note.findUniqueOrThrow({ where: { id: noteId } })).body).toBe("Called John; second round next week.");

    expect((await tool("list_notes", { id: ledgerly.id })).json).toMatchObject({
      id: ledgerly.id,
      notes: [{ note_id: noteId, text: "Called John; second round next week.", written: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) }],
      link: `https://dossier.example/applications/${ledgerly.id}?tab=notes`,
    });

    expect((await tool("save_note", { id: ledgerly.id, note_id: noteId, body: "Second round on Tuesday." })).json).toMatchObject({ note_id: noteId, changed: true });
    expect((await prisma().note.findUniqueOrThrow({ where: { id: noteId } })).body).toBe("Second round on Tuesday.");

    expect((await tool("save_note", { id: ledgerly.id, note_id: noteId, delete: true })).json).toMatchObject({ note_id: noteId, deleted: true, text: "Second round on Tuesday." });
    expect(await prisma().note.count({ where: { applicationId: ledgerly.id } })).toBe(0);
  });

  it("reads the notes newest first, with the status changes", async () => {
    const meridian = await application("Meridian Bank");
    await prisma().note.createMany({
      data: [
        { applicationId: meridian.id, body: "Older", createdAt: new Date("2026-10-01T10:00:00Z") },
        { applicationId: meridian.id, body: "Newer", createdAt: new Date("2026-10-20T10:00:00Z") },
      ],
    });
    const listed = await tool("list_notes", { id: meridian.id });
    expect((listed.json.notes as { text: string; written: string }[]).map(({ text, written }) => [text, written])).toEqual([
      ["Newer", "2026-10-20"],
      ["Older", "2026-10-01"],
    ]);
    expect(listed.json.status_changes).toEqual([{ from: "Draft", to: "Sent", on: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) }]);
  });

  it("says what's wrong with a note", async () => {
    const ledgerly = await application("Ledgerly");
    const theirs = await prisma().note.create({ data: { applicationId: (await application("Meridian Bank")).id, body: "Theirs" } });
    expect(await tool("save_note", { id: ledgerly.id })).toMatchObject({ isError: true, text: "Write the note's text in body." });
    expect(await tool("save_note", { id: ledgerly.id, body: "   " })).toMatchObject({ isError: true, text: expect.stringContaining("Write something first.") });
    expect(await tool("save_note", { id: ledgerly.id, delete: true })).toMatchObject({ isError: true, text: "Say which note to delete with its note_id from list_notes." });
    expect(await tool("save_note", { id: ledgerly.id, note_id: theirs.id, body: "Mine" })).toMatchObject({ isError: true, text: "That note no longer exists." });
    expect(await tool("save_note", { id: ledgerly.id, note_id: theirs.id, delete: true })).toMatchObject({ isError: true, text: "That note no longer exists." });
    expect((await prisma().note.findUniqueOrThrow({ where: { id: theirs.id } })).body).toBe("Theirs");
    expect(await tool("save_note", { id: "gone", body: "Hi" })).toMatchObject({ isError: true, text: "That application no longer exists." });
    expect(await tool("list_notes", { id: "gone" })).toMatchObject({ isError: true, text: "That application no longer exists." });
  });

  it("archives an application and brings it back, keeping when it was last updated", async () => {
    const kestrel = await application("Kestrel Maps");
    expect((await tool("update_application", { id: kestrel.id, archived: true })).json).toMatchObject({
      archived: true,
      done: ["Archived. It's off your board, and still counts on your dashboard."],
      link: `https://dossier.example/applications/${kestrel.id}`,
    });
    const archived = await saved(kestrel.id);
    expect(archived).toMatchObject({ archivedAt: expect.any(Date), updatedAt: kestrel.updatedAt });

    expect((await tool("update_application", { id: kestrel.id, archived: true })).json).toMatchObject({ archived: true, done: ["It was archived already."] });
    expect((await saved(kestrel.id)).archivedAt).toEqual(archived.archivedAt);

    expect((await tool("update_application", { id: kestrel.id, archived: false })).json).toMatchObject({ archived: false, done: ["Back on your board."] });
    expect(await saved(kestrel.id)).toMatchObject({ archivedAt: null, updatedAt: kestrel.updatedAt });
  });

  it("sets the next interview in the user's time zone or at the offset given, and removes it", async () => {
    const northstar = await application("Northstar Health");
    const set = await tool("update_application", { id: northstar.id, interview_at: "2026-11-04T14:00" });
    expect(set.json).toMatchObject({ next_interview: "2026-11-04T14:00:00+01:00", time_zone: "Europe/Berlin", done: ["Interview date saved. It'll show on your dashboard."] });
    expect(set.json.next).toBeUndefined();
    expect((await saved(northstar.id)).nextInterviewAt).toEqual(new Date("2026-11-04T13:00:00Z"));
    expect(calendar.sync).toHaveBeenLastCalledWith(northstar.id);

    // In summer time, and at an offset.
    expect((await tool("update_application", { id: northstar.id, interview_at: "2027-07-01T09:30" })).json.next_interview).toBe("2027-07-01T09:30:00+02:00");
    expect((await saved(northstar.id)).nextInterviewAt).toEqual(new Date("2027-07-01T07:30:00Z"));
    await tool("update_application", { id: northstar.id, interview_at: "2026-11-05T10:00:00-05:00" });
    expect((await saved(northstar.id)).nextInterviewAt).toEqual(new Date("2026-11-05T15:00:00Z"));

    expect((await tool("update_application", { id: northstar.id, interview_at: null })).json).toMatchObject({ next_interview: null, done: ["Interview date removed."] });
    expect((await saved(northstar.id)).nextInterviewAt).toBeNull();

    // Not in Interview yet: it's saved, and Claude learns where it shows.
    const kestrel = await application("Kestrel Maps");
    expect((await tool("update_application", { id: kestrel.id, interview_at: "2026-11-04T14:00" })).json.next).toMatch(/set_application_status/);
  });

  it("says when the calendar followed, and when it couldn't", async () => {
    const { GoogleError } = await import("@/lib/google/errors");
    const northstar = await application("Northstar Health");
    calendar.sync.mockResolvedValueOnce({ inCalendar: true, eventLink: "https://calendar.google.com/event?eid=1" });
    expect((await tool("update_application", { id: northstar.id, interview_at: "2026-11-04T14:00" })).json.done).toEqual(["Interview date saved, in your calendar too."]);
    calendar.sync.mockRejectedValueOnce(new GoogleError("unavailable", "Couldn't reach Google. Try again in a moment."));
    expect((await tool("update_application", { id: northstar.id, interview_at: null, archived: true })).json).toMatchObject({
      archived: true,
      done: ["Interview date removed, but your calendar wasn't changed: Couldn't reach Google. Try again in a moment.", "Archived. It's off your board, and still counts on your dashboard."],
    });
  });

  it("says what's wrong with an update, and changes nothing then", async () => {
    const kestrel = await application("Kestrel Maps");
    const nothing = "Say what to change: archived, interview_at, add_facts, change_facts, remove_facts or startup_id.";
    expect(await tool("update_application", { id: kestrel.id })).toMatchObject({ isError: true, text: nothing });
    expect(await tool("update_application", { id: kestrel.id, add_facts: [], remove_facts: [] })).toMatchObject({ isError: true, text: nothing });
    expect(await tool("update_application", { id: kestrel.id, archived: true, interview_at: "next Tuesday" })).toMatchObject({
      isError: true,
      text: "Give the interview's date and time like 2026-11-04T14:00, or null to remove it.",
    });
    expect(await tool("update_application", { id: kestrel.id, interview_at: "" })).toMatchObject({ isError: true, text: expect.stringMatching(/^Give the interview's date and time/) });
    expect(await saved(kestrel.id)).toMatchObject({ archivedAt: null, nextInterviewAt: null });
    expect(await tool("update_application", { id: "gone", archived: true })).toMatchObject({ isError: true, text: "That application no longer exists." });
  });

  it("adds, changes and removes the facts Dossier's AI is told for an application, and lists them", async () => {
    const ledgerly = await application("Ledgerly");
    const facts = () => prisma().fact.findMany({ where: { applicationId: ledgerly.id }, orderBy: [{ sort: "asc" }, { createdAt: "asc" }], select: { id: true, text: true } });
    const [seeded] = await facts();
    const profileFacts = () => prisma().fact.findMany({ where: { applicationId: null }, orderBy: { id: "asc" } });
    const profileBefore = await profileFacts();

    const added = await tool("update_application", { id: ledgerly.id, add_facts: ["A friend on their team referred me.", "  I can start in January.  "] });
    expect(added.json).toMatchObject({ done: ["Added 2 facts."], link: `https://dossier.example/applications/${ledgerly.id}?tab=posting` });
    const [, referral, start] = await facts();
    expect([referral.text, start.text]).toEqual(["A friend on their team referred me.", "I can start in January."]);
    expect(added.json.facts).toEqual([seeded, referral, start].map((fact) => ({ fact_id: fact.id, text: fact.text })));

    // One it has already isn't added again.
    expect((await tool("update_application", { id: ledgerly.id, add_facts: ["i can start in  January.", "Remote is fine."] })).json.done).toEqual(["Added 1 fact.", "1 fact was there already."]);
    expect(await facts()).toHaveLength(4);

    const changed = await tool("update_application", {
      id: ledgerly.id,
      change_facts: [{ fact_id: referral.id, text: "Anna Weber, their head of design, referred me." }],
      remove_facts: [seeded.id],
    });
    expect(changed.json).toMatchObject({
      done: ["Removed 1 fact.", "Changed 1 fact."],
      facts: [
        { fact_id: referral.id, text: "Anna Weber, their head of design, referred me." },
        { fact_id: start.id, text: "I can start in January." },
        { fact_id: expect.any(String), text: "Remote is fine." },
      ],
      // Kept in the answer, to add again if that was a mistake.
      removed_facts: [seeded.text],
    });
    expect((await facts()).map((fact) => fact.text)).toEqual(["Anna Weber, their head of design, referred me.", "I can start in January.", "Remote is fine."]);
    // The profile's own facts stay as they were.
    expect(await profileFacts()).toEqual(profileBefore);

    // With other changes, the link goes to the application.
    expect((await tool("update_application", { id: ledgerly.id, add_facts: ["Visa sponsorship isn't needed."], archived: true })).json).toMatchObject({
      done: ["Added 1 fact.", "Archived. It's off your board, and still counts on your dashboard."],
      archived: true,
      link: `https://dossier.example/applications/${ledgerly.id}`,
    });
  });

  it("says what's wrong with facts, and changes nothing then", async () => {
    const ledgerly = await application("Ledgerly");
    const [own] = await prisma().fact.findMany({ where: { applicationId: ledgerly.id } });
    const profileFact = await prisma().fact.findFirstOrThrow({ where: { applicationId: null } });
    const theirs = await prisma().fact.create({ data: { applicationId: (await application("Meridian Bank")).id, text: "Theirs" } });
    const textOf = async (id: string) => (await prisma().fact.findUniqueOrThrow({ where: { id } })).text;

    expect(await tool("update_application", { id: ledgerly.id, archived: true, remove_facts: [theirs.id] })).toMatchObject({ isError: true, text: `That fact isn't on this application: ${theirs.id}.` });
    expect(await tool("update_application", { id: ledgerly.id, change_facts: [{ fact_id: profileFact.id, text: "Mine" }, { fact_id: "gone", text: "Mine" }] })).toMatchObject({
      isError: true,
      text: `Those facts aren't on this application: ${profileFact.id}, gone.`,
    });
    expect(await tool("update_application", { id: ledgerly.id, change_facts: [{ fact_id: own.id, text: "New" }], remove_facts: [own.id] })).toMatchObject({
      isError: true,
      text: "A fact can be changed or removed, not both.",
    });
    expect(await tool("update_application", { id: ledgerly.id, add_facts: ["   "] })).toMatchObject({ isError: true, text: expect.stringContaining("Write the fact first.") });
    expect([await textOf(own.id), await textOf(profileFact.id), await textOf(theirs.id)]).toEqual([own.text, profileFact.text, "Theirs"]);

    // 49 facts: one more fits, two don't.
    await prisma().fact.createMany({ data: Array.from({ length: 48 }, (_, index) => ({ applicationId: ledgerly.id, text: `Fact ${index + 1}`, sort: 100 + index })) });
    expect(await tool("update_application", { id: ledgerly.id, add_facts: ["One more", "Two more"], interview_at: "2026-11-04T14:00" })).toMatchObject({
      isError: true,
      text: "An application keeps up to 50 facts. Remove one it no longer needs first.",
    });
    expect(await saved(ledgerly.id)).toMatchObject({ archivedAt: null, nextInterviewAt: null });
    expect(await prisma().fact.count({ where: { applicationId: ledgerly.id } })).toBe(49);
    // Removing one makes room.
    expect((await tool("update_application", { id: ledgerly.id, remove_facts: [own.id], add_facts: ["One more", "Two more"] })).json.done).toEqual(["Removed 1 fact.", "Added 2 facts."]);
    expect(await prisma().fact.count({ where: { applicationId: ledgerly.id } })).toBe(50);

    expect(await tool("update_application", { id: "gone", add_facts: ["Hi"] })).toMatchObject({ isError: true, text: "That application no longer exists." });
  });

  it("links an application to the startup it's written to, as Write to them does, and unlinks it", async () => {
    const startup = (company: string, emails: object[] = []) =>
      prisma().startup.create({ data: { source: "HN", externalId: company, company, roles: [], emails, links: [], reasons: [] } });
    const canalworks = await startup("Canalworks", [{ email: "jobs@canalworks.example", label: "Hiring", from: "https://canalworks.example/careers", onRequest: false, foundAt: "2026-10-23T08:00:00.000Z" }]);
    const quietly = await startup("Quietly");
    const kestrel = await application("Kestrel Maps");
    const linkedTo = async (id: string) => (await prisma().startup.findUniqueOrThrow({ where: { id } })).applicationId;

    expect((await tool("update_application", { id: kestrel.id, startup_id: canalworks.id })).json).toMatchObject({
      done: ["Linked to Canalworks. When Dossier writes the email, it fills in the address the startup publishes. The startup counts as contacted once the application is sent."],
      link: `https://dossier.example/applications/${kestrel.id}`,
    });
    expect(await linkedTo(canalworks.id)).toBe(kestrel.id);
    expect((await tool("update_application", { id: kestrel.id, startup_id: canalworks.id })).json.done).toEqual(["It was linked to Canalworks already."]);

    // An application is written to one startup.
    expect((await tool("update_application", { id: kestrel.id, startup_id: quietly.id })).json.done).toEqual([
      "Linked to Quietly instead of Canalworks. The startup counts as contacted once the application is sent.",
    ]);
    expect([await linkedTo(canalworks.id), await linkedTo(quietly.id)]).toEqual([null, kestrel.id]);

    // Another application's startup stays theirs.
    const northstar = await application("Northstar Health");
    expect(await tool("update_application", { id: northstar.id, startup_id: quietly.id, archived: true, add_facts: ["Met them at a meetup."] })).toMatchObject({
      isError: true,
      text: "Another application is linked to Quietly already.",
    });
    expect(await saved(northstar.id)).toMatchObject({ archivedAt: null });
    expect(await prisma().fact.count({ where: { applicationId: northstar.id } })).toBe(0);
    expect(await linkedTo(quietly.id)).toBe(kestrel.id);
    expect(await tool("update_application", { id: northstar.id, startup_id: "gone" })).toMatchObject({ isError: true, text: "That startup is no longer in the list." });

    expect((await tool("update_application", { id: kestrel.id, startup_id: null })).json.done).toEqual(["Unlinked from Quietly."]);
    expect(await linkedTo(quietly.id)).toBeNull();
    expect((await tool("update_application", { id: kestrel.id, startup_id: null })).json.done).toEqual(["It wasn't linked to a startup."]);

    // Now it's free for another one.
    expect((await tool("update_application", { id: northstar.id, startup_id: quietly.id })).json.done).toEqual(["Linked to Quietly. The startup counts as contacted once the application is sent."]);
    expect(await linkedTo(quietly.id)).toBe(northstar.id);
  });

  it("deletes an application with everything that belongs to it, its apply runs' files too", async () => {
    const ledgerly = await application("Ledgerly");
    await prisma().note.create({ data: { applicationId: ledgerly.id, body: "Private" } });
    await prisma().applyAttempt.createMany({ data: [{ id: "run-1", applicationId: ledgerly.id }, { id: "run-2", applicationId: ledgerly.id }] });
    await prisma().job.create({ data: { type: "write-email", key: `email:${ledgerly.id}`, applicationId: ledgerly.id, input: { applicationId: ledgerly.id } } });

    expect((await tool("delete_application", { id: ledgerly.id })).json).toEqual({
      id: ledgerly.id,
      deleted: true,
      title: ledgerly.title,
      company: "Ledgerly",
      link: "https://dossier.example/applications",
    });
    const left = await Promise.all([
      prisma().application.count({ where: { id: ledgerly.id } }),
      prisma().document.count({ where: { applicationId: ledgerly.id } }),
      prisma().note.count({ where: { applicationId: ledgerly.id } }),
      prisma().fact.count({ where: { applicationId: ledgerly.id } }),
      prisma().job.count({ where: { applicationId: ledgerly.id } }),
      prisma().applyAttempt.count({ where: { applicationId: ledgerly.id } }),
    ]);
    expect(left).toEqual([0, 0, 0, 0, 0, 0]);
    expect(deleteApplyRuns).toHaveBeenCalledOnce();
    expect([...deleteApplyRuns.mock.calls[0][0]].sort()).toEqual(["run-1", "run-2"]);
    expect(await prisma().application.count()).toBeGreaterThan(0);

    expect(await tool("delete_application", { id: ledgerly.id })).toMatchObject({ isError: true, text: "That application no longer exists." });
  });

  it("undoes the latest status change, one change a call, saying when it was made", async () => {
    const brightline = await application("Brightline Transit");
    expect(await tool("undo_status_change", { id: brightline.id })).toMatchObject({ isError: true, text: "There's no status change to undo." });

    await tool("set_application_status", { id: brightline.id, status: "SENT" });
    await tool("set_application_status", { id: brightline.id, status: "SCREENING" });
    const latest = () => prisma().statusEvent.findFirstOrThrow({ where: { applicationId: brightline.id }, orderBy: [{ at: "desc" }, { id: "desc" }] });
    const screening = await latest();
    expect((await tool("undo_status_change", { id: brightline.id })).json).toEqual({
      id: brightline.id,
      status: "Sent",
      was: "Screening",
      changed_on: screening.at.toISOString().slice(0, 10),
      link: `https://dossier.example/applications/${brightline.id}`,
    });
    const sent = await latest();
    expect((await tool("undo_status_change", { id: brightline.id })).json).toMatchObject({ status: "Draft", was: "Sent", changed_on: sent.at.toISOString().slice(0, 10) });
    expect(await saved(brightline.id)).toMatchObject({ status: "DRAFT", furthestStage: null, sentAt: null });
    expect(await prisma().statusEvent.count({ where: { applicationId: brightline.id } })).toBe(0);

    expect(await tool("undo_status_change", { id: "gone" })).toMatchObject({ isError: true, text: "That application no longer exists." });
  });

  it("has Dossier's own model write the email in the background, following a writing under way", async () => {
    const ledgerly = await application("Ledgerly");
    const first = await tool("write_application_email", { id: ledgerly.id });
    expect(first.json).toMatchObject({
      task_id: expect.any(String),
      status: "started",
      application_id: ledgerly.id,
      link: `https://dossier.example/applications/${ledgerly.id}?tab=email`,
      next: expect.stringContaining("check_task"),
    });
    expect(await prisma().job.findUniqueOrThrow({ where: { id: first.json.task_id as string } })).toMatchObject({
      type: "write-email",
      key: `email:${ledgerly.id}`,
      applicationId: ledgerly.id,
      input: { applicationId: ledgerly.id },
    });
    expect((await tool("write_application_email", { id: ledgerly.id })).json.task_id).toBe(first.json.task_id);

    fake.ai = false;
    expect(await tool("write_application_email", { id: ledgerly.id })).toMatchObject({ isError: true, text: "That needs an AI provider. Choose one in Settings → AI provider." });
    expect(await tool("write_application_email", { id: "gone" })).toMatchObject({ isError: true, text: "That application no longer exists." });
  });

  it("puts back the email the last rewrite replaced, unless it has changed since", async () => {
    const ledgerly = await application("Ledgerly");
    const email = [
      { id: "to", label: "Recipient", text: "" },
      { id: "subject", label: "Subject", text: "Application" },
      { id: "body", label: "Message", text: "Dear team,\n\nHello." },
    ];
    const rewritten = email.map((unit) => (unit.id === "body" ? { ...unit, text: "Dear team,\n\nHi again." } : unit));
    const finished = (result: object, createdAt: string) =>
      prisma().job.create({
        data: { type: "write-email", key: `email:${ledgerly.id}`, applicationId: ledgerly.id, status: "DONE", input: { applicationId: ledgerly.id }, result, createdAt: new Date(createdAt) },
      });
    const units = async () => (await prisma().document.findUniqueOrThrow({ where: { applicationId_kind: { applicationId: ledgerly.id, kind: "EMAIL" } } })).units;

    expect(await tool("write_application_email", { id: ledgerly.id, undo: true })).toMatchObject({ isError: true, text: "There's nothing to undo." });

    await prisma().document.create({ data: { applicationId: ledgerly.id, kind: "EMAIL", units: rewritten } });
    await finished({ units: email, previous: null }, "2026-10-23T09:00:00Z");
    await finished({ units: rewritten, previous: email }, "2026-10-23T10:00:00Z");
    expect((await tool("write_application_email", { id: ledgerly.id, undo: true })).json).toMatchObject({ done: "Put the email back." });
    expect(await units()).toEqual(email);
    expect(await prisma().documentVersion.findMany({ where: { document: { applicationId: ledgerly.id, kind: "EMAIL" } }, select: { cause: true } })).toEqual([{ cause: "UNDONE" }]);

    expect(await tool("write_application_email", { id: ledgerly.id, undo: true })).toMatchObject({ isError: true, text: expect.stringMatching(/^The email has changed since/) });
    await finished({ units: email, previous: null }, "2026-10-23T11:00:00Z");
    expect(await tool("write_application_email", { id: ledgerly.id, undo: true })).toMatchObject({ isError: true, text: "There's nothing to undo." });
    expect(await units()).toEqual(email);
    expect(await tool("write_application_email", { id: "gone", undo: true })).toMatchObject({ isError: true, text: "That application no longer exists." });
  });
});
