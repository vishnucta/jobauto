import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { encryptApiKey } from "@/lib/ai/api-key";
import { AiError } from "@/lib/ai/errors";
import { MockProvider } from "@/lib/ai/providers/mock";
import { json, stubFetch } from "@/lib/ai/test-http";
import { clearJobSearchCache } from "@/lib/job-search/cache";
import { encryptSecret, GOOGLE_CLIENT_SECRET, JOB_SOURCE_KEY } from "@/lib/secrets";
import { loadProfileSettings } from "@/lib/profiles";
import { loadSettings, saveSettings } from "@/lib/settings-data";
import { appVersion } from "@/lib/version";
import { createTestClient, resetDatabase, TEST_PROFILE_ID } from "@/test/db";
import { jsearchV2LastPage } from "@/test/job-search-fixtures";

import { seedBuiltIns } from "../../../../prisma/seed/built-ins";
import { seedDemo } from "../../../../prisma/seed/demo";

import { challengeOf, exchangeCode, issueCode, registerClient } from "../oauth";

// The connector's settings tools (jobauto fork), called as
// Claude calls them, through /api/mcp, against the test database with the
// demo data.

const db = vi.hoisted(() => ({ client: undefined as ReturnType<typeof createTestClient> | undefined }));
vi.mock("@/lib/prisma", async () => {
  const { createTestClient } = await import("@/test/db");
  db.client = createTestClient();
  return { prisma: db.client };
});
const fakeEnv = vi.hoisted(() => ({
  DOSSIER_SECRET: "s".repeat(40),
  DOSSIER_PASSWORD: "argon2id:m=19456,t=2,p=1:c2FsdA:aGFzaA",
  DOSSIER_DATA_DIR: "",
  DOSSIER_JOBS_ARBEITSAGENTUR: undefined as "off" | undefined,
  DOSSIER_AI_PROVIDER: undefined as "anthropic" | undefined,
  DOSSIER_AI_KEY: undefined as string | undefined,
}));
vi.mock("@/lib/env", async () => {
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  // No backups in it: the last one reads as never.
  fakeEnv.DOSSIER_DATA_DIR = path.join(tmpdir(), "dossier-mcp-settings-test");
  return { env: fakeEnv };
});
// The real AI config and key handling, with a mock model behind them, or
// the real providers over a stubbed fetch while a test sets none.
const provider = vi.hoisted(() => ({ current: undefined as unknown }));
vi.mock("@/lib/ai", async (importOriginal) => {
  const ai = await importOriginal<typeof import("@/lib/ai")>();
  return { ...ai, createProvider: vi.fn((config: Parameters<typeof ai.createProvider>[0]) => provider.current ?? ai.createProvider(config)) };
});

import { POST } from "@/app/api/mcp/route";

const prisma = () => db.client!;
const settings = () => loadSettings();
/** The first profile's own settings (E24-1): its Base resume's theme and language. */
const own = () => loadProfileSettings(TEST_PROFILE_ID);
const CLAUDE = "https://claude.ai/api/mcp/auth_callback";

let token = "";
beforeEach(async () => {
  await resetDatabase(prisma());
  await seedBuiltIns(prisma());
  await seedDemo(prisma(), { now: new Date("2026-10-23T09:00:00Z") });
  await saveSettings({ connectorEnabledAt: "2026-10-23T09:00:00.000Z" });
  provider.current = new MockProvider({ model: "qwen2.5:3b", models: ["qwen2.5:3b", "llama3.1:8b"] });
  fakeEnv.DOSSIER_JOBS_ARBEITSAGENTUR = undefined;
  fakeEnv.DOSSIER_AI_PROVIDER = undefined;
  fakeEnv.DOSSIER_AI_KEY = undefined;
  clearJobSearchCache();
  const clientId = await registerClient({ name: "Claude", redirectUris: [CLAUDE] });
  const verifier = "v".repeat(50);
  const code = await issueCode({ clientId, redirectUri: CLAUDE, codeChallenge: challengeOf(verifier), resource: "" });
  token = (await exchangeCode({ code, clientId, redirectUri: CLAUDE, verifier })).access_token;
});
afterEach(() => vi.unstubAllGlobals());
afterAll(() => prisma().$disconnect());

type Content = { type: "text"; text: string } | { type: "resource"; resource: { uri: string; mimeType?: string; text: string } };

/** Sends one request to /api/mcp as Claude does; its result. */
async function rpc(method: string, params: Record<string, unknown> = {}) {
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

/** Calls a tool; its first answer, parsed when it's JSON, whether it's an error, and everything it answered. */
async function tool(name: string, args: Record<string, unknown> = {}) {
  const result = await rpc("tools/call", { name, arguments: args });
  const content = result.content as Content[];
  const text = content[0].type === "text" ? content[0].text : "";
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    // A plain message.
  }
  return { isError: (result.isError ?? false) as boolean, text, json: json as Record<string, unknown>, content };
}

describe("get_settings and update_settings", () => {
  it("tells every setting by its section, keys only by whether they're saved", async () => {
    await saveSettings({
      provider: "ANTHROPIC",
      model: "claude-opus-5-5",
      apiKeyEnc: encryptApiKey("sk-ant-secret"),
      // Every portal with its own switch and fields (E22-3); keys apart, encrypted.
      portals: { JSEARCH: { on: true, fields: {}, acceptedAt: null }, ADZUNA: { on: false, fields: { appId: "app-1" }, acceptedAt: null } },
      portalKeysEnc: { JSEARCH: { key: encryptSecret(JOB_SOURCE_KEY, "ak_secret") } },
      googleClientId: "1234-client.apps.googleusercontent.com",
      googleClientSecretEnc: encryptSecret(GOOGLE_CLIENT_SECRET, "gcs_secret"),
      gmailInterval: 30,
      docLanguage: "German",
      customLanguages: ["Hebrew"],
    });
    const read = await tool("get_settings");
    expect(read.json).toMatchObject({
      ai: { ai_provider: "ANTHROPIC", provider_name: "Anthropic", ai_address: "https://api.anthropic.com", ai_model: "claude-opus-5-5", api_key: "set", ready: true, creativity: "BALANCED", never_invent_experience: true },
      scoring: { scorer: "Your AI model" },
      job_search: { archive_after_days: 30 },
      documents: { paper: "A4", document_language: "German", resume_language: "English", documents_to_write: "both", languages: expect.arrayContaining(["English", "German", "Hebrew"]) },
      your_data: { nightly_backup: true, last_backup: null, keep_task_data_hours: 24 },
      // Set up, but no account connected yet.
      google: { status: "disconnected", gmail_read: true, gmail_interval: 30, calendar_id: "primary", work_start: "09:00", work_time_zone: "" },
      about: { version: appVersion, check_for_updates_daily: true, newer_version: null },
      link: "https://dossier.example/settings",
    });
    const portals = (read.json.job_search as { portals: Record<string, unknown>[] }).portals;
    // SerpApi (jobauto fork) is a built-in portal beside upstream's.
    expect(portals.map((portal) => [portal.id, portal.on])).toEqual([
      ["JSEARCH", true],
      ["SERPAPI", false],
      ["ADZUNA", false],
      ["FREEHIRE", false],
      ["ARBEITSAGENTUR", false],
    ]);
    expect(portals[0]).toMatchObject({ name: "JSearch", fields: { key: "key: set" } });
    expect(portals[2]).toMatchObject({ name: "Adzuna", fields: { appId: "app-1", key: "key: none" } });
    expect(portals[4]).toMatchObject({ id: "ARBEITSAGENTUR", note_accepted: false });
    const stored = await settings();
    for (const secret of ["sk-ant-secret", "ak_secret", "gcs_secret", stored.apiKeyEnc!, stored.portalKeysEnc.JSEARCH.key, stored.googleClientSecretEnc!, "1234-client"]) {
      expect(read.text).not.toContain(secret);
    }

    // Connected: what Google allows, never the account's address or its token.
    await prisma().googleAccount.create({
      data: { email: "jane.doe@example.com", refreshTokenEnc: "v1.token", scopes: "openid email https://www.googleapis.com/auth/gmail.readonly", lastSyncAt: new Date("2026-10-23T08:00:00Z") },
    });
    const connected = await tool("get_settings");
    expect(connected.json.google).toMatchObject({ status: "connected", google_allows: { sending: false, reading: true, calendar: false }, last_inbox_check: "2026-10-23T08:00:00.000Z" });
    expect(connected.text).not.toContain("jane.doe@example.com");
    expect(connected.text).not.toContain("v1.token");
  });

  it("changes the plain choices, document languages and data settings given, and only those", async () => {
    const changed = await tool("update_settings", {
      creativity: "EXPRESSIVE",
      never_invent_experience: false,
      paper: "LETTER",
      documents_to_write: "resume",
      resume_language: "German",
      file_name_pattern: "{name} – {doc}",
      keep_task_data_hours: 168,
      check_for_updates_daily: false,
    });
    expect(changed.json).toMatchObject({
      saved: ["creativity", "never_invent_experience", "paper", "resume_language", "file_name_pattern", "documents_to_write", "keep_task_data_hours", "check_for_updates_daily"],
      ai: { creativity: "EXPRESSIVE", never_invent_experience: false, show_what_changed: true },
      // The resume language is the first profile's own (E24-1).
      documents: { paper: "LETTER", documents_to_write: "resume", resume_language: "German", file_name_pattern: "{name} – {doc}" },
      your_data: { keep_task_data_hours: 168 },
      about: { check_for_updates_daily: false },
      link: "https://dossier.example/settings?section=ai",
    });
    expect(changed.json).not.toHaveProperty("job_search");
    expect(await settings()).toMatchObject({
      creativity: "EXPRESSIVE",
      strict: false,
      showDiff: true,
      paper: "LETTER",
      documentsToWrite: "resume",
      fileNamePattern: "{name} – {doc}",
      jobRetentionHours: 168,
      updateCheck: false,
      nightlyBackup: true,
    });
    expect((await own()).resumeLanguage).toBe("German");

    // A new language goes on the list, as "Other language…" adds it; one there already, in any case, is picked.
    expect((await tool("update_settings", { document_language: " Hebrew " })).json).toMatchObject({ documents: { document_language: "Hebrew" }, link: "https://dossier.example/settings?section=documents" });
    await tool("update_settings", { document_language: "HEBREW", resume_language: "English", nightly_backup: false });
    expect(await settings()).toMatchObject({ docLanguage: "Hebrew", customLanguages: ["Hebrew"], nightlyBackup: false });
    expect((await own()).resumeLanguage).toBeNull();
    await tool("update_settings", { document_language: null });
    expect((await settings()).docLanguage).toBeNull();

    expect(await tool("update_settings")).toMatchObject({ isError: true, text: "Give at least one setting to change. get_settings shows them all." });
    expect(await tool("update_settings", { keep_task_data_hours: 5 })).toMatchObject({ isError: true });
    expect(await tool("update_settings", { resume_language: "Klingon" })).toMatchObject({ isError: true });
    // Keys aren't settings it changes: one given is left out, and then there's nothing to change.
    expect(await tool("update_settings", { api_key: "sk-ant-secret" })).toMatchObject({ isError: true, text: "Give at least one setting to change. get_settings shows them all." });
    expect((await settings()).apiKeyEnc).toBeNull();
    expect((await settings()).jobRetentionHours).toBe(168);
  });

  it("switches the AI provider as its card does, removing the key, and changes the model on its own", async () => {
    await saveSettings({ provider: "ANTHROPIC", model: "claude-opus-5-5", apiKeyEnc: encryptApiKey("sk-ant-secret") });
    // The same provider keeps its key.
    expect((await tool("update_settings", { ai_model: "claude-sonnet-5" })).json).toMatchObject({ ai: { ai_provider: "ANTHROPIC", ai_model: "claude-sonnet-5", api_key: "set", ready: true } });
    expect(await settings()).toMatchObject({ provider: "ANTHROPIC", baseUrl: "https://api.anthropic.com", model: "claude-sonnet-5" });
    expect((await settings()).apiKeyEnc).not.toBeNull();

    const groq = await tool("update_settings", { ai_provider: "GROQ" });
    expect(groq.json).toMatchObject({
      ai: { ai_provider: "GROQ", ai_address: "https://api.groq.com/openai/v1", ai_model: "openai/gpt-oss-120b", api_key: "none", ready: false },
      next: expect.stringContaining("Settings → AI provider"),
    });
    expect(await settings()).toMatchObject({ provider: "GROQ", apiKeyEnc: null });
    expect((await tool("update_settings", { ai_provider: "DEEPSEEK" })).json).toMatchObject({
      ai: { ai_provider: "DEEPSEEK", ai_address: "https://api.deepseek.com", ai_model: "deepseek-flash", api_key: "none", ready: false },
    });
    expect((await tool("update_settings", { ai_provider: "GEMINI" })).json).toMatchObject({
      ai: { ai_provider: "GEMINI", ai_address: "https://generativelanguage.googleapis.com/v1beta/openai", ai_model: "gemini-3.8-flash", api_key: "none", ready: false },
    });

    // At the card's address: another server is the user's to set.
    const local = await tool("update_settings", { ai_provider: "LOCAL", ai_model: "qwen2.5:3b" });
    expect(local.json).toMatchObject({ ai: { ai_provider: "LOCAL", ai_address: "http://localhost:11434", ai_model: "qwen2.5:3b", ready: true } });
    expect(local.json).not.toHaveProperty("next");
  });

  it("switches portals on and off and sets their fields, never ticking the Bundesagentur für Arbeit's note for the user (#223)", async () => {
    const portal = async (id: string) => ((await tool("get_settings")).json.job_search as { portals: { id: string }[] }).portals.find((entry) => entry.id === id);
    const refused = await tool("update_settings", { portals: [{ id: "JSEARCH", on: true }, { id: "ARBEITSAGENTUR", on: true }], paper: "LETTER" });
    expect(refused).toMatchObject({ isError: true, text: expect.stringContaining("“I understand”") });
    // Nothing else changed either.
    expect(await settings()).toMatchObject({ portals: null, paper: "A4" });

    const jsearch = await tool("update_settings", { portals: [{ id: "JSEARCH", on: true, fields: { host: "rapidapi" } }, { id: "ADZUNA", fields: { appId: " app-1 " } }] });
    expect(jsearch.json).toMatchObject({ saved: ["portals"], link: "https://dossier.example/settings?section=jobs" });
    expect(await portal("JSEARCH")).toMatchObject({ on: true, fields: { host: "rapidapi", key: "key: none" } });
    expect(await settings()).toMatchObject({ portals: { JSEARCH: { on: true, fields: { host: "rapidapi" } }, ADZUNA: { on: false, fields: { appId: "app-1" } } } });
    expect(await tool("update_settings", { portals: [{ id: "JSEARCH", fields: { host: "elsewhere" } }] })).toMatchObject({ isError: true, text: expect.stringContaining("Choose one of the options.") });

    // Once the user ticked it in Settings, switching it on needs nothing more.
    await saveSettings({ portals: { ...(await settings()).portals, ARBEITSAGENTUR: { on: false, fields: {}, acceptedAt: "2026-10-20T08:00:00.000Z" } } });
    await tool("update_settings", { portals: [{ id: "ARBEITSAGENTUR", on: true }] });
    expect(await portal("ARBEITSAGENTUR")).toMatchObject({ on: true, note_accepted: true });
    await tool("update_settings", { portals: [{ id: "JSEARCH", on: false }, { id: "ADZUNA", fields: { appId: "" } }] });
    expect(await settings()).toMatchObject({ portals: { JSEARCH: { on: false }, ADZUNA: { fields: {} } } });

    // A server can turn it off (DOSSIER_JOBS_ARBEITSAGENTUR=off), and a portal it doesn't have isn't there to switch.
    fakeEnv.DOSSIER_JOBS_ARBEITSAGENTUR = "off";
    expect(await tool("update_settings", { portals: [{ id: "ARBEITSAGENTUR", on: true }] })).toMatchObject({ isError: true, text: expect.stringContaining("isn't offered on this server") });
    expect(await tool("update_settings", { portals: [{ id: "LINKEDIN", on: true }] })).toMatchObject({ isError: true });
  });
});

describe("the AI provider's server, where the key and everything the AI reads go", () => {
  const ANOTHER_SERVER = "Only the user can point the AI at another server, in Settings → AI provider: the API key and everything the AI reads go wherever it points.";
  const message = { id: "m1", type: "message", role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: "OK" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } };
  /** Wherever Anthropic's API is asked: its models, and an answer to every message. */
  const anthropicApi = () => stubFetch(({ url }) => (url.pathname.endsWith("/models") ? json({ data: [{ id: "claude-opus-5-5", type: "model" }], has_more: false }) : json(message)));

  // The real providers, to see where they send the key.
  beforeEach(() => {
    provider.current = undefined;
  });

  it("only changes the path on the same server, so the saved key goes nowhere else", async () => {
    await saveSettings({ provider: "ANTHROPIC", model: "claude-opus-5-5", apiKeyEnc: encryptApiKey("sk-ant-secret") });
    const requests = anthropicApi();
    for (const change of [
      { ai_address: "https://evil.example" },
      { ai_address: "https://api.anthropic.com@evil.example" },
      { ai_address: "http://api.anthropic.com" },
      { ai_address: "api.anthropic.com" },
      { ai_provider: "ANTHROPIC", ai_address: "https://evil.example/v1", ai_model: "claude-sonnet-5" },
      // Needing no key, these would send everything the AI reads there.
      { ai_provider: "LOCAL", ai_address: "http://evil.example:11434" },
      { ai_provider: "OPENAI", ai_address: "https://evil.example/v1" },
      // Nothing else changes either.
      { ai_address: "https://evil.example", portals: [{ id: "JSEARCH", on: true }], paper: "LETTER" },
    ]) {
      expect(await tool("update_settings", change), JSON.stringify(change)).toMatchObject({ isError: true, text: ANOTHER_SERVER });
    }
    expect(await settings()).toMatchObject({ provider: "ANTHROPIC", baseUrl: null, model: "claude-opus-5-5", portals: null, paper: "A4" });
    expect((await settings()).apiKeyEnc).not.toBeNull();

    expect((await tool("update_settings", { ai_address: "https://api.anthropic.com/" })).json).toMatchObject({ ai: { ai_address: "https://api.anthropic.com/", api_key: "set", ready: true } });
    expect((await tool("list_ai_models")).json).toMatchObject({ models: ["claude-opus-5-5"] });
    expect((await tool("test_connection", { connection: "ai_provider" })).json).toMatchObject({ connected: true, model: "claude-opus-5-5" });
    expect(requests.map(({ url }) => url.origin)).toEqual(["https://api.anthropic.com", "https://api.anthropic.com"]);
    for (const request of requests) expect(request.headers.get("x-api-key")).toBe("sk-ant-secret");
  });

  it("switches to the provider DOSSIER_AI_KEY is for at its usual server only", async () => {
    fakeEnv.DOSSIER_AI_PROVIDER = "anthropic";
    fakeEnv.DOSSIER_AI_KEY = "sk-ant-env";
    await saveSettings({ provider: "GROQ", model: "openai/gpt-oss-120b" });
    const requests = anthropicApi();
    expect(await tool("update_settings", { ai_provider: "ANTHROPIC", ai_address: "https://evil.example" })).toMatchObject({ isError: true, text: ANOTHER_SERVER });
    expect((await settings()).provider).toBe("GROQ");

    expect((await tool("update_settings", { ai_provider: "ANTHROPIC" })).json).toMatchObject({
      ai: { ai_provider: "ANTHROPIC", ai_address: "https://api.anthropic.com", ai_model: "claude-opus-5-5", api_key: "env", ready: true },
    });
    expect(await tool("update_settings", { ai_address: "https://evil.example" })).toMatchObject({ isError: true, text: ANOTHER_SERVER });
    expect((await tool("list_ai_models")).json).toMatchObject({ models: ["claude-opus-5-5"] });
    expect((await tool("test_connection", { connection: "ai_provider" })).json).toMatchObject({ connected: true });
    expect(requests.map(({ url }) => url.origin)).toEqual(["https://api.anthropic.com", "https://api.anthropic.com"]);
    for (const request of requests) expect(request.headers.get("x-api-key")).toBe("sk-ant-env");
  });
});

describe("the AI provider's models and the Test connection buttons", () => {
  it("lists the provider's models, or says why it can't", async () => {
    expect((await tool("list_ai_models")).json).toMatchObject({ ai_provider: "LOCAL", models: ["qwen2.5:3b", "llama3.1:8b"], link: "https://dossier.example/settings?section=ai" });
    provider.current = {
      listModels: async () => {
        throw new AiError("unreachable", "Couldn't reach the server. Check the address and that it's running.");
      },
    };
    expect(await tool("list_ai_models")).toMatchObject({ isError: true, text: "Couldn't reach the server. Check the address and that it's running." });
  });

  it("tests the AI provider with a short prompt, timed", async () => {
    expect((await tool("test_connection", { connection: "ai_provider" })).json).toEqual({
      connection: "ai_provider",
      connected: true,
      model: "qwen2.5:3b",
      seconds: expect.any(Number),
      link: "https://dossier.example/settings?section=ai",
    });
    provider.current = new MockProvider({ model: null });
    expect((await tool("test_connection", { connection: "ai_provider" })).json).toMatchObject({ connected: false, problem: "Choose a model in Settings → AI provider first." });
  });

  it("tests a portal with its key", async () => {
    expect((await tool("test_connection", { connection: "portal", portal: "JSEARCH" })).json).toMatchObject({
      portal: "JSearch",
      connected: false,
      problem: "Add your JSearch key in Settings → Job search first.",
      link: "https://dossier.example/settings?section=jobs",
    });
    await saveSettings({ portalKeysEnc: { JSEARCH: { key: encryptSecret(JOB_SOURCE_KEY, "ak_secret") } } });
    clearJobSearchCache();
    const requests = stubFetch(() => json(jsearchV2LastPage));
    expect((await tool("test_connection", { connection: "portal", portal: "JSEARCH" })).json).toMatchObject({ portal: "JSearch", connected: true, seconds: expect.any(Number) });
    expect(requests[0].headers.get("x-api-key")).toBe("ak_secret");
    stubFetch(() => json({}, { status: 401 }));
    expect((await tool("test_connection", { connection: "portal", portal: "JSEARCH" })).json).toMatchObject({
      connected: false,
      problem: "JSearch didn't accept your key. Check it in Settings → Job search.",
    });
    expect(await tool("test_connection", { connection: "portal" })).toMatchObject({ isError: true });
    expect(await tool("test_connection", { connection: "portal", portal: "LINKEDIN" })).toMatchObject({ isError: true });
    expect(await tool("test_connection", { connection: "gmail" })).toMatchObject({ isError: true });
  });
});

describe("the tools' hints", () => {
  it("marks reads as read-only, and what can't be undone or reaches out as such", async () => {
    const { tools } = (await rpc("tools/list")) as { tools: { name: string; description: string; annotations?: Record<string, boolean> }[] };
    const hints = Object.fromEntries(tools.map((entry) => [entry.name, entry.annotations ?? {}]));
    expect(hints.get_settings).toEqual({ readOnlyHint: true, openWorldHint: false });
    expect(hints.list_ai_models).toEqual({ readOnlyHint: true, openWorldHint: true });
    // A portal's test spends one of the user's paid searches (round 2 of the audit).
    expect(hints.test_connection).toEqual({ readOnlyHint: false, destructiveHint: false, openWorldHint: true });
    expect(tools.find((entry) => entry.name === "test_connection")?.description).toContain("paid search");
    // Switching the AI provider, which removes its key, can't be undone.
    expect(hints.update_settings).toEqual({ readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false });
    // The themes, Download all PDFs, Export and Check for updates stay on the screens: an export holds contact details and private notes.
    for (const name of ["list_themes", "set_base_theme", "save_theme", "zip_all_pdfs", "export_data", "check_for_updates"]) expect(hints, name).not.toHaveProperty(name);
  });
});
