import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MockProvider } from "@/lib/ai/providers/mock";
import { startJob } from "@/lib/jobs/runner";
import { encryptSecret, GOOGLE_TOKEN } from "@/lib/secrets";
import { saveSettings } from "@/lib/settings-data";
import { createTestClient, resetDatabase } from "@/test/db";

import { challengeOf, exchangeCode, issueCode, registerClient } from "../oauth";

// The inbox's tools (E15, jobauto fork), called as Claude calls them,
// through /api/mcp, against the test database, with Google's APIs answered
// by a fake fetch and the AI by a mock.

const db = vi.hoisted(() => ({ client: undefined as ReturnType<typeof createTestClient> | undefined }));
vi.mock("@/lib/prisma", async () => {
  const { createTestClient } = await import("@/test/db");
  db.client = createTestClient();
  return { prisma: db.client };
});
vi.mock("@/lib/env", () => ({
  env: {
    DOSSIER_SECRET: "s".repeat(40),
    DOSSIER_PASSWORD: "argon2id:m=19456,t=2,p=1:c2FsdA:aGFzaA",
    DOSSIER_GOOGLE_CLIENT_ID: "client",
    DOSSIER_GOOGLE_CLIENT_SECRET: "secret",
    DOSSIER_DATA_DIR: "/tmp",
  },
}));
const fake = vi.hoisted(() => ({ aiReady: true, provider: undefined as unknown }));
vi.mock("@/lib/ai", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/ai")>()), getAiProvider: async () => fake.provider }));
vi.mock("@/lib/ai/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ai/config")>()),
  isAiConfigured: async () => fake.aiReady,
  isAiUsable: async () => fake.aiReady,
}));
vi.mock("@/lib/ai/task-options", () => ({ loadTaskOptions: async () => ({ creativity: "BALANCED", strict: true, language: null }) }));
// Sending renders the PDFs; here they're a few bytes, held up while `pdf.gate` is.
const pdf = vi.hoisted(() => ({ gate: undefined as Promise<void> | undefined, rendering: () => {} }));
vi.mock("@/lib/pdf/render", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/pdf/render")>()),
  renderPdf: async () => {
    pdf.rendering();
    await pdf.gate;
    return new Uint8Array([37, 80, 68, 70]);
  },
}));
vi.mock("@/lib/time-zone", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/time-zone")>()),
  userTimeZone: async () => "Europe/Berlin",
  lastKnownTimeZone: async () => "Europe/Berlin",
}));
// Drafting an answer is a background job that calls the AI; here it only starts.
vi.mock("@/lib/jobs/runner", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/jobs/runner")>()),
  startJob: vi.fn(async () => "reply-job"),
}));

import { POST } from "@/app/api/mcp/route";

const prisma = () => db.client!;
const CLAUDE = "https://claude.ai/api/mcp/auth_callback";
const NOT_CONNECTED = "Google isn't connected to Dossier. Connect it in the app under Settings → Google.";
const CHANGED = "The email changed or already went out. Show the user the preview again.";
const SCOPES = {
  send: "https://www.googleapis.com/auth/gmail.send",
  read: "https://www.googleapis.com/auth/gmail.readonly",
  calendar: "https://www.googleapis.com/auth/calendar.freebusy https://www.googleapis.com/auth/calendar.events",
};
const b64 = (text: string) => Buffer.from(text).toString("base64url");

/** Mail in the fake Gmail. */
type Mail = { id: string; threadId: string; from: string; subject: string; text: string };
let mailbox: Mail[] = [];
let sent: { raw: string; threadId?: string }[] = [];
let calls: string[] = [];

/** Google's APIs as Dossier uses them: the token, Gmail and Calendar. */
function fakeGoogle(url: string, init?: RequestInit): Response {
  calls.push(url);
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  const path = new URL(url).pathname;
  if (url.startsWith("https://oauth2.googleapis.com/token")) return json({ access_token: "access", expires_in: 3600, scope: "" });
  if (path.endsWith("/profile")) return json({ historyId: "200" });
  if (path.endsWith("/messages") && (init?.method ?? "GET") === "GET") return json({ messages: mailbox.map((mail) => ({ id: mail.id })) });
  if (path.endsWith("/messages/send")) {
    const body = JSON.parse(String(init?.body)) as { raw: string; threadId?: string };
    sent.push(body);
    return json({ id: `sent-${sent.length}`, threadId: body.threadId ?? "thread-new" });
  }
  if (path.endsWith("/freeBusy")) return json({ calendars: { primary: { busy: [] } } });
  if (path.includes("/events")) return json({ id: "ev1", htmlLink: "https://calendar.google.com/event?eid=ev1" });
  const mail = mailbox.find((entry) => entry.id === /messages\/([^/?]+)/.exec(path)?.[1]);
  if (!mail) return new Response("not found", { status: 404 });
  return json({
    id: mail.id,
    threadId: mail.threadId,
    labelIds: ["INBOX"],
    internalDate: String(new Date("2026-10-29T10:00:00Z").getTime()),
    payload: {
      mimeType: "multipart/alternative",
      headers: [
        { name: "From", value: mail.from },
        { name: "To", value: "jane@gmail.com" },
        { name: "Subject", value: mail.subject },
        { name: "Message-ID", value: `<${mail.id}@mail.example>` },
      ],
      parts: [{ mimeType: "text/plain", body: { data: b64(mail.text) } }],
    },
  });
}

let token = "";
beforeEach(async () => {
  await resetDatabase(prisma());
  await saveSettings({ connectorEnabledAt: "2026-10-23T09:00:00.000Z" });
  fake.aiReady = true;
  fake.provider = new MockProvider({ reply: () => ({ kind: "OFFER", summary: "Makes you an offer.", questions: [], confirmedTime: null }) });
  mailbox = [];
  sent = [];
  calls = [];
  pdf.gate = undefined;
  pdf.rendering = () => {};
  vi.mocked(startJob).mockClear();
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL, init?: RequestInit) => fakeGoogle(String(url), init)));
  const clientId = await registerClient({ name: "Claude", redirectUris: [CLAUDE] });
  const verifier = "v".repeat(50);
  const code = await issueCode({ clientId, redirectUri: CLAUDE, codeChallenge: challengeOf(verifier), resource: "" });
  token = (await exchangeCode({ code, clientId, redirectUri: CLAUDE, verifier })).access_token;

  await prisma().googleAccount.create({
    data: { email: "jane@gmail.com", refreshTokenEnc: encryptSecret(GOOGLE_TOKEN, "refresh", "s".repeat(40)), scopes: ["openid email", SCOPES.send, SCOPES.read, SCOPES.calendar].join(" ") },
  });
  await prisma().profileField.create({ data: { key: "name", value: "Jane Doe" } });
  await prisma().application.create({ data: { id: "nw", company: "Northwind", role: "Product Designer", status: "SENT", furthestStage: "SENT", sentAt: new Date(), emailThreadId: "t1" } });
  await prisma().application.create({ data: { id: "lg", company: "Ledgerly", role: "Designer", status: "SENT", furthestStage: "SENT", sentAt: new Date() } });
  await prisma().application.create({
    data: {
      id: "ac",
      company: "Acme",
      role: "UX Writer",
      status: "DRAFT",
      documents: {
        create: [
          {
            kind: "EMAIL",
            units: [
              { id: "to", label: "Recipient", text: "careers@acme.example" },
              { id: "subject", label: "Subject", text: "Application: UX Writer" },
              { id: "body", label: "Message", text: "Dear team,\n\nI'm applying.\n\nJane" },
            ],
          },
          { kind: "RESUME", units: [] },
          { kind: "COVER_LETTER", units: [] },
        ],
      },
    },
  });
  const reply = { direction: "INCOMING" as const, fromName: "Anna Keller", fromAddress: "anna@northwind.example", toAddress: "jane@gmail.com", subject: "Re: Application" };
  await prisma().emailMessage.createMany({
    data: [
      {
        ...reply,
        id: "e1",
        gmailId: "g1",
        threadId: "t1",
        applicationId: "nw",
        messageId: "<g1@northwind.example>",
        body: "Could we talk on Wednesday at 14:00?",
        sentAt: new Date("2026-10-27T13:00:00Z"),
        kind: "INTERVIEW",
        summary: "Invites you to a call.",
        questions: ["When are you free?"],
        suggestedStatus: "INTERVIEW",
        confirmedAt: new Date("2026-11-04T13:00:00Z"),
        classifiedWith: "classify-reply@1",
      },
      { ...reply, id: "e2", gmailId: "g2", threadId: "t2", fromName: "Acme Talent", fromAddress: "talent@acme.example", subject: "A role for you?", body: "Interested in a role?", sentAt: new Date("2026-10-28T09:00:00Z") },
      {
        ...reply,
        id: "e3",
        gmailId: "g3",
        threadId: "t1",
        applicationId: "nw",
        body: "Thanks for applying!",
        sentAt: new Date("2026-10-20T09:00:00Z"),
        kind: "ACKNOWLEDGEMENT",
        summary: "Got your application.",
        handledAt: new Date(),
        classifiedWith: "classify-reply@1",
      },
      {
        id: "e0",
        gmailId: "g0",
        threadId: "t1",
        applicationId: "nw",
        direction: "OUTGOING",
        fromName: "Jane Doe",
        fromAddress: "jane@gmail.com",
        toAddress: "careers@northwind.example",
        subject: "Application: Product Designer",
        body: "Dear team, I'm applying.",
        sentAt: new Date("2026-10-18T09:00:00Z"),
        handledAt: new Date(),
      },
    ],
  });
});
afterEach(() => vi.unstubAllGlobals());
afterAll(() => prisma().$disconnect());

/** One JSON-RPC call to /api/mcp, as Claude makes it; its result. */
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
async function tool(name: string, args: Record<string, unknown> = {}): Promise<{ isError: boolean; text: string; json: Record<string, unknown> }> {
  const result = await rpc("tools/call", { name, arguments: args });
  const text = result.content[0].text as string;
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    // A plain message.
  }
  return { isError: result.isError ?? false, text, json: json as Record<string, unknown> };
}

const email = (id: string) => prisma().emailMessage.findUniqueOrThrow({ where: { id } });
const withoutScope = (scope: string) =>
  prisma().googleAccount.update({ where: { id: "google" }, data: { scopes: ["openid email", SCOPES.send, SCOPES.read, SCOPES.calendar].filter((entry) => entry !== scope).join(" ") } });

describe("the inbox's tools", () => {
  it("are listed with what they may do", async () => {
    const { tools } = (await rpc("tools/list", {})) as { tools: { name: string; annotations?: Record<string, boolean> }[] };
    const annotations = Object.fromEntries(tools.map((entry) => [entry.name, entry.annotations ?? {}]));
    expect(annotations.list_emails).toMatchObject({ readOnlyHint: true });
    expect(annotations.read_email).toMatchObject({ readOnlyHint: true });
    expect(annotations.find_free_slots).toMatchObject({ readOnlyHint: true, openWorldHint: true });
    for (const name of ["send_email_reply", "send_application_email"]) expect(annotations[name]).toMatchObject({ readOnlyHint: false, destructiveHint: true, openWorldHint: true });
    expect(annotations.update_email).toMatchObject({ destructiveHint: true });
    expect(annotations.confirm_interview).toMatchObject({ openWorldHint: true, idempotentHint: true });
    expect(annotations.update_google_settings).toMatchObject({ readOnlyHint: false, idempotentHint: true });
    expect(Object.keys(annotations)).toEqual(expect.arrayContaining(["check_inbox", "draft_email_reply", "save_email_reply"]));
  });

  it("say to connect Google while it isn't", async () => {
    await prisma().googleAccount.deleteMany();
    const every: [string, Record<string, unknown>][] = [
      ["check_inbox", {}],
      ["list_emails", {}],
      ["read_email", { email_id: "e1" }],
      ["draft_email_reply", { email_id: "e1" }],
      ["save_email_reply", { email_id: "e1", text: "Hi" }],
      ["send_email_reply", { email_id: "e1", text: "Hi" }],
      ["update_email", { email_id: "e1", change: "handled" }],
      ["find_free_slots", {}],
      ["confirm_interview", { email_id: "e1" }],
      ["send_application_email", { application_id: "ac", confirm: true }],
      ["update_google_settings", { gmail_read: false }],
    ];
    for (const [name, args] of every) expect(await tool(name, args), name).toEqual({ isError: true, text: NOT_CONNECTED, json: null });
    expect(sent).toEqual([]);
    expect(await email("e1")).toMatchObject({ handledAt: null });
  });

  it("list the inbox and an application's conversation, without the mails' text", async () => {
    const inbox = await tool("list_emails");
    expect(inbox.json).toMatchObject({
      time_zone: "Europe/Berlin",
      needs_an_answer: [
        {
          id: "e1",
          from: "Anna Keller",
          date: "Tue, 27 Oct 2026, 14:00",
          summary: "Invites you to a call.",
          kind: "interview invite",
          application: { id: "nw", company: "Northwind", role: "Product Designer", status: "Sent" },
          suggested_status: "Interview",
        },
      ],
      needs_a_look: [{ id: "e2", from: "Acme Talent", subject: "A role for you?", summary: "Interested in a role?", read_by_ai: false }],
      needs_a_look_hint: expect.stringContaining("update_email"),
      updates: [{ id: "e3", kind: "acknowledgement" }],
      link: "https://dossier.example/inbox",
    });
    expect(inbox.text).not.toContain("Could we talk");

    const conversation = await tool("list_emails", { application_id: "nw" });
    expect((conversation.json.emails as { id: string; from: string }[]).map((entry) => [entry.id, entry.from])).toEqual([
      ["e0", "the user"],
      ["e3", "Anna Keller"],
      ["e1", "Anna Keller"],
    ]);
    expect(conversation.json.link).toBe("https://dossier.example/applications/nw?tab=conversation");
    expect(conversation.text).not.toContain("jane@gmail.com");
    expect(await tool("list_emails", { application_id: "gone" })).toMatchObject({ isError: true, text: "That application no longer exists." });
  });

  it("read one email with what the AI read in it, leaving out the user's address", async () => {
    const one = await tool("read_email", { email_id: "e1" });
    expect(one.json).toMatchObject({
      id: "e1",
      from: { name: "Anna Keller", address: "anna@northwind.example" },
      text: "Could we talk on Wednesday at 14:00?",
      application: { id: "nw", status: "Sent" },
      ai_read: {
        kind: "interview invite",
        summary: "Invites you to a call.",
        questions: ["When are you free?"],
        suggested_status: "Interview",
        agreed_interview: { start: "2026-11-04T13:00:00.000Z", when: "Wed, 4 Nov 2026, 14:00" },
      },
      answer: { handled: false },
      next: expect.arrayContaining([expect.stringContaining("confirm_interview"), expect.stringContaining("draft_email_reply")]),
      link: "https://dossier.example/applications/nw?tab=conversation",
    });
    expect(one.text).not.toContain("jane@gmail.com");

    const own = await tool("read_email", { email_id: "e0" });
    expect(own.json).toMatchObject({ from: "the user", text: "Dear team, I'm applying." });
    expect(own.json.ai_read).toBeUndefined();
    expect(own.text).not.toContain("jane@gmail.com");
    expect(await tool("read_email", { email_id: "gone" })).toMatchObject({ isError: true, text: "That email is no longer in Dossier." });
  });

  it("check Gmail now, while reading replies is on and allowed", async () => {
    mailbox = [{ id: "m1", threadId: "t1", from: "Anna Keller <anna@northwind.example>", subject: "Re: Application", text: "Does Thursday work too?" }];
    expect((await tool("check_inbox")).json).toEqual({ new_emails: 1, read_by_ai: 1, link: "https://dossier.example/inbox", next: "See them with list_emails." });
    expect(await prisma().emailMessage.findFirstOrThrow({ where: { gmailId: "m1" } })).toMatchObject({ applicationId: "nw", kind: "OFFER" });

    await tool("update_google_settings", { gmail_read: false });
    expect((await tool("check_inbox")).text).toContain("Reading replies is off.");
    await withoutScope(SCOPES.read);
    expect((await tool("check_inbox")).text).toBe("Dossier isn't allowed to read Gmail yet. Allow it in the app under Settings → Google.");
  });

  it("have Dossier's AI draft an answer in the background, only when there is one", async () => {
    expect((await tool("draft_email_reply", { email_id: "e1", note: "Wednesday works" })).json).toMatchObject({ task_id: "reply-job", status: "started", email_id: "e1" });
    expect(startJob).toHaveBeenCalledWith(expect.objectContaining({ type: "draft-reply" }), { emailId: "e1", note: "Wednesday works", slots: null }, { key: "reply:e1", applicationId: "nw" });
    const slots = ["2026-11-05T09:00:00.000Z", "2026-11-06T09:00:00.000Z"];
    await tool("draft_email_reply", { email_id: "e1", slots });
    expect(vi.mocked(startJob).mock.calls[1][1]).toEqual({ emailId: "e1", note: "", slots });

    expect(await tool("draft_email_reply", { email_id: "e0" })).toMatchObject({ isError: true, text: "That's an email the user sent. Use the employer's email instead." });
    fake.aiReady = false;
    expect((await tool("draft_email_reply", { email_id: "e1" })).text).toContain("save_email_reply");
    expect(startJob).toHaveBeenCalledTimes(2);
  });

  it("save an answer, and send it in the thread once it's complete", async () => {
    const saved = await tool("save_email_reply", { email_id: "e1", text: "Hi Anna, my notice period is […]." });
    expect(saved.json).toMatchObject({ saved: true, to: "Anna Keller", next: "Fill in the parts marked […] before it can be sent." });
    // Linked, read and waiting for an answer: the Conversation tab shows it.
    expect(saved.json.reopened).toBeUndefined();
    expect(saved.json.not_in_app).toBeUndefined();
    expect((await tool("read_email", { email_id: "e1" })).json.answer).toMatchObject({ draft: "Hi Anna, my notice period is […]." });
    expect(await tool("send_email_reply", { email_id: "e1", text: "Hi Anna, my notice period is […]." })).toMatchObject({ isError: true, text: "Fill in the parts marked […] first." });
    expect(sent).toEqual([]);

    expect((await tool("send_email_reply", { email_id: "e1", text: "Hi Anna,\n\nWednesday works.\n\nJane" })).json).toMatchObject({ sent: true, to: "Anna Keller", subject: "Re: Application" });
    expect(sent).toHaveLength(1);
    expect(sent[0].threadId).toBe("t1");
    const raw = Buffer.from(sent[0].raw, "base64url").toString("utf8");
    expect(raw).toContain("To: Anna Keller <anna@northwind.example>");
    expect(raw).toContain("In-Reply-To: <g1@northwind.example>");
    expect(await email("e1")).toMatchObject({ handledAt: expect.any(Date), replyDraft: "" });
    // Asked again after a lost answer, the same text in the same thread isn't sent twice; another answer is.
    expect(await tool("send_email_reply", { email_id: "e1", text: "Hi Anna,\n\nWednesday works.\n\nJane" })).toMatchObject({
      isError: true,
      text: "That exact answer went out a few minutes ago, so it isn't sent again. Check read_email.",
    });
    expect(sent).toHaveLength(1);
    expect((await tool("send_email_reply", { email_id: "e1", text: "Hi Anna,\n\nOne more thing: I can start in March.\n\nJane" })).json).toMatchObject({ sent: true });
    expect(sent).toHaveLength(2);

    expect(await tool("send_email_reply", { email_id: "e0", text: "Hello" })).toMatchObject({ isError: true });
    expect(await tool("save_email_reply", { email_id: "gone", text: "Hello" })).toMatchObject({ isError: true, text: "That email is no longer in Dossier." });
    await withoutScope(SCOPES.send);
    expect((await tool("send_email_reply", { email_id: "e3", text: "Thanks!" })).text).toBe("Dossier isn't allowed to send with Gmail yet. Allow it in the app under Settings → Google.");
    expect(sent).toHaveLength(2);
  });

  it("reopen mail marked as needing no answer for its draft, and say when the app can't show the draft", async () => {
    // e3, an acknowledgement, was marked as needing no answer when the AI read it.
    const saved = await tool("save_email_reply", { email_id: "e3", text: "Thanks, Anna!" });
    expect(saved.json).toMatchObject({ saved: true, reopened: "It was marked as needing no answer. Now it needs one again.", link: "https://dossier.example/applications/nw?tab=conversation" });
    expect(saved.json.not_in_app).toBeUndefined();
    expect(await email("e3")).toMatchObject({ handledAt: null, replyDraft: "Thanks, Anna!" });
    expect((await tool("list_emails")).json.needs_an_answer).toEqual(expect.arrayContaining([expect.objectContaining({ id: "e3", answer_drafted: true })]));

    // Removing the draft leaves it as it is.
    await prisma().emailMessage.update({ where: { id: "e3" }, data: { handledAt: new Date() } });
    expect((await tool("save_email_reply", { email_id: "e3", text: "" })).json.reopened).toBeUndefined();
    expect(await email("e3")).toMatchObject({ handledAt: expect.any(Date), replyDraft: "" });

    // Dossier's AI drafting one reopens it too.
    expect((await tool("draft_email_reply", { email_id: "e3" })).json).toMatchObject({ task_id: "reply-job", reopened: expect.any(String) });
    expect(await email("e3")).toMatchObject({ handledAt: null });

    // Mail not linked to an application, or not read yet, has no answer box in the app.
    expect((await tool("save_email_reply", { email_id: "e2", text: "Hi, tell me more." })).json).toMatchObject({
      saved: true,
      not_in_app: expect.stringContaining("only for mail linked to an application"),
      link: "https://dossier.example/inbox",
    });
    expect((await tool("draft_email_reply", { email_id: "e2" })).json).toMatchObject({ not_in_app: expect.stringContaining("only for mail linked to an application") });
    await prisma().emailMessage.update({ where: { id: "e2" }, data: { applicationId: "lg" } });
    expect((await tool("save_email_reply", { email_id: "e2", text: "Hi, tell me more." })).json).toMatchObject({ not_in_app: expect.stringContaining("once Dossier's AI has read the email") });
    expect(await email("e2")).toMatchObject({ replyDraft: "Hi, tell me more." });

    // Read as an acknowledgement, it would need no answer; with an answer drafted, it still needs one.
    fake.provider = new MockProvider({ reply: () => ({ kind: "ACKNOWLEDGEMENT", summary: "Got your message.", questions: [], confirmedTime: null }) });
    expect((await tool("update_email", { email_id: "e2", change: "read_again" })).json).toMatchObject({ ai_read: { kind: "acknowledgement" }, handled: false });
    expect((await tool("read_email", { email_id: "e2" })).json.answer).toEqual({ handled: false, draft: "Hi, tell me more." });
  });

  it("dismiss only mail that isn't linked to an application", async () => {
    expect(await tool("update_email", { email_id: "e1", change: "dismiss" })).toEqual({
      isError: true,
      text: "That email is linked to an application. Mark it handled instead, or unlink it first if it isn't job-related.",
      json: null,
    });
    expect(await email("e1")).toMatchObject({ body: "Could we talk on Wednesday at 14:00?", summary: "Invites you to a call.", applicationId: "nw", dismissedAt: null });
    expect((await tool("read_email", { email_id: "e1" })).json).toMatchObject({ text: "Could we talk on Wednesday at 14:00?" });
  });

  it("mark, link, read again, take up a suggestion and dismiss", async () => {
    expect((await tool("update_email", { email_id: "e3", change: "not_handled" })).json).toMatchObject({ handled: false });
    expect(await email("e3")).toMatchObject({ handledAt: null });
    await tool("update_email", { email_id: "e3", change: "handled" });
    expect(await email("e3")).toMatchObject({ handledAt: expect.any(Date) });

    expect(await tool("update_email", { email_id: "e2", change: "link" })).toMatchObject({ isError: true, text: "Say which application it's about: give application_id." });
    expect(await tool("update_email", { email_id: "e2", change: "link", application_id: "gone" })).toMatchObject({ isError: true, text: "That application no longer exists." });
    expect((await tool("update_email", { email_id: "e2", change: "link", application_id: "lg" })).json).toMatchObject({
      application: { id: "lg", company: "Ledgerly" },
      link: "https://dossier.example/applications/lg?tab=conversation",
    });

    expect((await tool("update_email", { email_id: "e2", change: "read_again" })).json).toMatchObject({ ai_read: { kind: "offer", summary: "Makes you an offer.", suggested_status: "Offer" } });
    expect((await tool("update_email", { email_id: "e2", change: "decline_status" })).json).toMatchObject({ suggestion: "turned down" });
    expect(await prisma().application.findUniqueOrThrow({ where: { id: "lg" } })).toMatchObject({ status: "SENT" });
    expect(await tool("update_email", { email_id: "e2", change: "accept_status" })).toMatchObject({ isError: true, text: "That email doesn't suggest a status." });

    expect((await tool("update_email", { email_id: "e1", change: "accept_status" })).json).toMatchObject({ application_id: "nw", status: "Interview", changed: true });
    expect(await prisma().application.findUniqueOrThrow({ where: { id: "nw" } })).toMatchObject({ status: "INTERVIEW" });

    fake.aiReady = false;
    expect(await tool("update_email", { email_id: "e2", change: "read_again" })).toMatchObject({ isError: true, text: "That needs an AI provider. Choose one in Settings → AI provider." });

    expect((await tool("update_email", { email_id: "e2", change: "unlink" })).json).toMatchObject({ application: null, link: "https://dossier.example/inbox" });
    expect((await tool("update_email", { email_id: "e2", change: "dismiss" })).json).toMatchObject({ dismissed: true });
    expect(await email("e2")).toMatchObject({ body: "", fromAddress: "", dismissedAt: expect.any(Date) });
    expect(await tool("read_email", { email_id: "e2" })).toMatchObject({ isError: true, text: "That email is no longer in Dossier." });
    expect((await tool("list_emails")).json.needs_a_look).toEqual([]);
  });

  it("find free times in the calendar, and add an agreed interview", async () => {
    const free = await tool("find_free_slots");
    expect(free.json).toMatchObject({ time_zone: "Europe/Berlin" });
    const slots = free.json.slots as { start: string; label: string }[];
    expect(slots.length).toBeGreaterThan(0);
    expect(slots[0].label).toMatch(/^\w{3} \d{1,2} \w{3}, \d{2}:\d{2}–\d{2}:\d{2}$/);
    expect(calls.some((url) => url.endsWith("/freeBusy"))).toBe(true);

    expect((await tool("confirm_interview", { email_id: "e1" })).json).toEqual({
      application_id: "nw",
      interview: "Wed 4 Nov, 14:00–14:45",
      start: "2026-11-04T13:00:00.000Z",
      in_calendar: true,
      calendar_link: "https://calendar.google.com/event?eid=ev1",
      status: "Interview",
      link: "https://dossier.example/applications/nw",
    });
    expect(await prisma().application.findUniqueOrThrow({ where: { id: "nw" } })).toMatchObject({ status: "INTERVIEW", nextInterviewAt: new Date("2026-11-04T13:00:00Z"), interviewEventId: "ev1" });
    expect(await email("e1")).toMatchObject({ confirmedAt: null, suggestedStatus: null });

    expect(await tool("confirm_interview", { email_id: "e2" })).toMatchObject({ isError: true, text: "Link this email to an application first." });
    expect(await tool("confirm_interview", { email_id: "e3" })).toMatchObject({ isError: true, text: "Give the interview's start: that email doesn't agree on a time." });

    await tool("update_google_settings", { calendar_availability: false, calendar_events: false });
    expect((await tool("find_free_slots")).text).toContain("Offering times from the calendar is off.");
    const moved = await tool("confirm_interview", { email_id: "e3", start: "2026-11-06T10:00:00+01:00", move_to_interview: false });
    expect(moved.json).toMatchObject({ start: "2026-11-06T09:00:00.000Z", in_calendar: false });
    expect(moved.json.status).toBeUndefined();
    await withoutScope(SCOPES.calendar);
    expect((await tool("find_free_slots")).text).toBe("Dossier isn't allowed to use Google Calendar yet. Allow it in the app under Settings → Google.");
  });

  it("show the application's email first, and send it only when confirmed", async () => {
    const preview = await tool("send_application_email", { application_id: "ac" });
    expect(preview.json).toMatchObject({
      sent: false,
      to: "careers@acme.example",
      subject: "Application: UX Writer",
      message: "Dear team,\n\nI'm applying.\n\nJane",
      attachments: [expect.stringContaining("Acme"), expect.stringContaining("Acme")],
      moves_to: "Sent",
      confirm_token: expect.any(String),
      link: "https://dossier.example/applications/ac?tab=email",
    });
    expect(preview.text).not.toContain("jane@gmail.com");
    expect(sent).toEqual([]);

    const done = await tool("send_application_email", { application_id: "ac", confirm: true, confirm_token: preview.json.confirm_token });
    expect(done.json).toMatchObject({ sent: true, status: "Sent", link: "https://dossier.example/applications/ac?tab=conversation" });
    expect(sent).toHaveLength(1);
    const raw = Buffer.from(sent[0].raw, "base64url").toString("utf8");
    expect(raw).toContain("To: careers@acme.example");
    expect(raw).toContain("application/pdf");
    expect(await prisma().application.findUniqueOrThrow({ where: { id: "ac" } })).toMatchObject({ status: "SENT", emailThreadId: "thread-new" });
    expect((await tool("send_application_email", { application_id: "ac" })).json).toMatchObject({ sent_before: true });

    expect(await tool("send_application_email", { application_id: "lg", confirm: true, confirm_token: "made-up" })).toMatchObject({ isError: true, text: "Write the email first." });
    expect(await tool("send_application_email", { application_id: "gone" })).toMatchObject({ isError: true, text: "That application no longer exists." });
    await withoutScope(SCOPES.send);
    expect((await tool("send_application_email", { application_id: "ac", confirm: true, confirm_token: preview.json.confirm_token })).text).toBe(
      "Dossier isn't allowed to send with Gmail yet. Allow it in the app under Settings → Google.",
    );
    expect(sent).toHaveLength(1);
  });

  it("send only the email the user saw, and only once", async () => {
    expect(await tool("send_application_email", { application_id: "ac", confirm: true })).toMatchObject({ isError: true, text: expect.stringContaining("call send_application_email without confirm") });

    // Changed after the user saw it: refused until they've seen it again.
    const shown = (await tool("send_application_email", { application_id: "ac" })).json.confirm_token;
    const document = await prisma().document.findFirstOrThrow({ where: { applicationId: "ac", kind: "EMAIL" } });
    const units = document.units as { id: string; label: string; text: string }[];
    const edited = "Dear team,\n\nI'm applying, and here's why.\n\nJane";
    await prisma().document.update({ where: { id: document.id }, data: { units: units.map((unit) => (unit.id === "body" ? { ...unit, text: edited } : unit)) } });
    expect(await tool("send_application_email", { application_id: "ac", confirm: true, confirm_token: shown })).toEqual({ isError: true, text: CHANGED, json: null });
    expect(sent).toEqual([]);

    const again = await tool("send_application_email", { application_id: "ac" });
    expect(again.json).toMatchObject({ message: edited });
    expect(again.json.confirm_token).not.toBe(shown);
    expect((await tool("send_application_email", { application_id: "ac", confirm: true, confirm_token: again.json.confirm_token })).json).toMatchObject({ sent: true });

    // The same confirm again, e.g. a retry after a timeout, doesn't send it twice.
    expect(await tool("send_application_email", { application_id: "ac", confirm: true, confirm_token: again.json.confirm_token })).toEqual({ isError: true, text: CHANGED, json: null });
    expect(sent).toHaveLength(1);
    expect(await prisma().emailMessage.findMany({ where: { applicationId: "ac", direction: "OUTGOING" } })).toEqual([expect.objectContaining({ body: edited })]);
  });

  it("send it once when the same confirm comes again while it's still going out", async () => {
    const shown = (await tool("send_application_email", { application_id: "ac" })).json.confirm_token;
    let release = () => {};
    pdf.gate = new Promise((resolve) => (release = resolve));
    const rendering = new Promise<void>((resolve) => (pdf.rendering = resolve));
    const first = tool("send_application_email", { application_id: "ac", confirm: true, confirm_token: shown });
    await rendering;

    expect(await tool("send_application_email", { application_id: "ac", confirm: true, confirm_token: shown })).toEqual({ isError: true, text: "It's being sent right now.", json: null });
    release();
    expect((await first).json).toMatchObject({ sent: true, status: "Sent" });
    expect(sent).toHaveLength(1);
    expect(await tool("send_application_email", { application_id: "ac", confirm: true, confirm_token: shown })).toMatchObject({ isError: true, text: CHANGED });
    expect(sent).toHaveLength(1);
  });

  it("approve a job agent draft they send, once its email is complete", async () => {
    await prisma().application.update({ where: { id: "ac" }, data: { awaitingReview: true } });
    await prisma().agentCandidate.create({ data: { source: "JSEARCH", externalId: "agent-1", dedupeKey: "agent-1", status: "DRAFTED", applicationId: "ac" } });
    const preview = await tool("send_application_email", { application_id: "ac" });
    expect(preview.json).toMatchObject({ waiting_for_review: expect.stringContaining("Sending it approves it.") });
    expect(await prisma().application.findUniqueOrThrow({ where: { id: "ac" } })).toMatchObject({ awaitingReview: true });
    const shown = preview.json.confirm_token;

    const email = await prisma().document.findFirstOrThrow({ where: { applicationId: "ac", kind: "EMAIL" } });
    await prisma().document.update({ where: { id: email.id }, data: { units: [{ id: "to", label: "Recipient", text: "" }] } });
    expect(await tool("send_application_email", { application_id: "ac", confirm: true, confirm_token: shown })).toMatchObject({
      isError: true,
      text: "Add who it's to first: the posting doesn't give an address.",
    });
    expect(await prisma().application.findUniqueOrThrow({ where: { id: "ac" } })).toMatchObject({ awaitingReview: true });

    // Nor with a token for something else.
    await prisma().document.update({ where: { id: email.id }, data: { units: email.units as object[] } });
    expect(await tool("send_application_email", { application_id: "ac", confirm: true, confirm_token: "stale" })).toEqual({ isError: true, text: CHANGED, json: null });
    expect(await prisma().application.findUniqueOrThrow({ where: { id: "ac" } })).toMatchObject({ awaitingReview: true });

    expect((await tool("send_application_email", { application_id: "ac", confirm: true, confirm_token: shown })).json).toMatchObject({ sent: true, status: "Sent" });
    expect(await prisma().application.findUniqueOrThrow({ where: { id: "ac" } })).toMatchObject({ awaitingReview: false, status: "SENT" });
    expect(await prisma().agentCandidate.findFirstOrThrow()).toMatchObject({ status: "APPROVED" });
  });

  it("change the Google settings, refusing a day that ends before it starts or a made-up zone", async () => {
    expect((await tool("update_google_settings")).json).toMatchObject({
      gmail_read: true,
      gmail_scope: "known",
      work_days: [1, 2, 3, 4, 5],
      work_start: "09:00",
      work_end: "17:00",
      work_time_zone: "",
      time_zone_used: "Europe/Berlin",
      google_allows: { sending: true, reading: true, calendar: true },
      link: "https://dossier.example/settings?section=google",
    });
    expect((await tool("update_google_settings", { work_days: [3, 1, 1], work_time_zone: "America/New_York", gmail_scope: "all", slot_minutes: 60 })).json).toMatchObject({
      work_days: [1, 3],
      work_time_zone: "America/New_York",
      time_zone_used: "America/New_York",
      gmail_scope: "all",
      slot_minutes: 60,
    });
    const rows = Object.fromEntries((await prisma().setting.findMany()).map((row) => [row.key, row.value]));
    expect(rows).toMatchObject({ workDays: "[1,3]", workTimeZone: "America/New_York", gmailScope: "all", slotMinutes: "60" });

    expect(await tool("update_google_settings", { work_start: "18:00" })).toMatchObject({ isError: true, text: "The working day has to end after it starts." });
    expect(await tool("update_google_settings", { work_time_zone: "Mars/Olympus" })).toMatchObject({ isError: true });
    expect((await tool("update_google_settings", { work_start: "08:00", work_time_zone: "" })).json).toMatchObject({ work_start: "08:00", work_end: "17:00", work_time_zone: "" });
  });
});
