import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { encryptApiKey } from "@/lib/ai/api-key";
import { AiError } from "@/lib/ai/errors";
import { MockProvider } from "@/lib/ai/providers/mock";
import { json, stubFetch } from "@/lib/ai/test-http";
import { exportSchema } from "@/lib/data-export";
import { clearJobSearchCache } from "@/lib/job-search/cache";
import { startJob } from "@/lib/jobs/runner";
import { zipPdfsJob } from "@/lib/jobs/zip-pdfs";
import { encryptSecret, GOOGLE_CLIENT_SECRET, JOB_SOURCE_KEY } from "@/lib/secrets";
import { loadSettings, saveSettings } from "@/lib/settings-data";
import { themeFile } from "@/lib/theme-file";
import { BUILT_IN_THEMES } from "@/lib/themes";
import { appVersion } from "@/lib/version";
import { createTestClient, resetDatabase } from "@/test/db";
import { jsearchV2LastPage } from "@/test/job-search-fixtures";

import { seedBuiltIns } from "../../../../prisma/seed/built-ins";
import { seedDemo } from "../../../../prisma/seed/demo";

import { challengeOf, exchangeCode, issueCode, registerClient } from "../oauth";

// The connector's themes, settings and export tools (jobauto fork), called as
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
// Zipping renders PDFs; here it only starts.
vi.mock("@/lib/jobs/runner", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/jobs/runner")>()),
  startJob: vi.fn(async () => "zip-job"),
}));

import { POST } from "@/app/api/mcp/route";

const prisma = () => db.client!;
const settings = () => loadSettings();
const CLAUDE = "https://claude.ai/api/mcp/auth_callback";
const THEME_GONE = "There's no theme with that id. list_themes shows them all.";

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
  vi.mocked(startJob).mockClear();
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

describe("the theme tools (RES-2…RES-4, E5-7)", () => {
  it("lists every theme with its look and use, and sets the base theme", async () => {
    const listed = await tool("list_themes");
    expect(listed.json.base_theme_id).toBe("editorial");
    const themes = listed.json.themes as Record<string, unknown>[];
    expect(themes.map((theme) => theme.id)).toEqual(BUILT_IN_THEMES.map((theme) => theme.id));
    // The demo's application uses Editorial for both its documents.
    expect(themes[0]).toEqual({
      id: "editorial",
      name: "Editorial",
      built_in: true,
      applications: 1,
      head_font: "NEWSREADER",
      body_font: "GEIST",
      accent: "#7a3b2e",
      layout: "SINGLE",
      align: "LEFT",
      heading_style: "PLAIN",
      density: "REGULAR",
      header_style: "PLAIN",
      sidebar_style: "PLAIN",
      date_style: "INLINE",
      photo_shape: "CIRCLE",
      photo_position: "HEADER_END",
    });
    expect(listed.json.link).toBe("https://dossier.example/resume");

    expect((await tool("set_base_theme", { id: "modern" })).json).toEqual({ base_theme: { id: "modern", name: "Modern" }, link: "https://dossier.example/resume" });
    expect((await settings()).baseThemeId).toBe("modern");
    expect(await tool("set_base_theme", { id: "gone" })).toMatchObject({ isError: true, text: THEME_GONE });
    expect((await settings()).baseThemeId).toBe("modern");
  });

  it("makes a new theme from the base theme or another, and changes custom ones only", async () => {
    const made = await tool("save_theme", { accent: "#2D6A4F", head_font: "PLEX_MONO" });
    expect(made.json).toMatchObject({
      message: "Saved “My theme”. It's now your base resume theme.",
      // The rest is Editorial's, the base theme.
      theme: { name: "My theme", accent: "#2d6a4f", head_font: "PLEX_MONO", body_font: "GEIST", layout: "SINGLE" },
    });
    const id = (made.json.theme as { id: string }).id;
    expect((await settings()).baseThemeId).toBe(id);

    await tool("set_base_theme", { id: "classic" });
    const changed = await tool("save_theme", { id, name: "Green mono", density: "AIRY" });
    expect(changed.json).toMatchObject({ theme: { id, name: "Green mono", density: "AIRY", accent: "#2d6a4f", head_font: "PLEX_MONO" } });
    expect((await settings()).baseThemeId).toBe(id);
    expect(await prisma().theme.count({ where: { builtIn: false } })).toBe(1);
    expect((await tool("list_themes")).json.themes).toContainEqual(expect.objectContaining({ id, name: "Green mono", built_in: false, applications: 0 }));

    // From another theme: with changes, as the builder starts one; alone, a copy as Duplicate makes it.
    expect((await tool("save_theme", { based_on: "modern", accent: "#1f3a5f" })).json).toMatchObject({ theme: { name: "My theme", layout: "SPLIT", accent: "#1f3a5f" } });
    expect((await tool("save_theme", { based_on: "modern" })).json).toMatchObject({ message: "Made “Modern copy”. It's now your base resume theme.", theme: { name: "Modern copy", accent: "#2f5d8a" } });

    expect(await tool("save_theme", { id: "editorial", accent: "#000000" })).toMatchObject({ isError: true, text: expect.stringMatching(/^Built-in themes can't be changed/) });
    expect((await prisma().theme.findUniqueOrThrow({ where: { id: "editorial" } })).accent).toBe("#7a3b2e");
    expect(await tool("save_theme", { id: "gone", accent: "#000000" })).toMatchObject({ isError: true, text: THEME_GONE });
    expect(await tool("save_theme", { based_on: "gone" })).toMatchObject({ isError: true, text: THEME_GONE });
    expect(await tool("save_theme", { id })).toMatchObject({ isError: true, text: "Say what to change, for example accent or head_font." });
    expect(await tool("save_theme", {})).toMatchObject({ isError: true });
    expect(await tool("save_theme", { id, based_on: "modern", accent: "#000000" })).toMatchObject({ isError: true });
    expect(await tool("save_theme", { accent: "red" })).toMatchObject({ isError: true });
    expect(await prisma().theme.count({ where: { builtIn: false } })).toBe(3);
  });

  it("imports a theme file's text, checked as the screen checks it", async () => {
    const file = themeFile({ ...BUILT_IN_THEMES[0], name: "Shared theme", accent: "#1F6F5C" });
    const imported = await tool("save_theme", { theme_file: JSON.stringify(file) });
    expect(imported.json).toMatchObject({ message: "Imported “Shared theme”. It's now your base resume theme.", theme: { name: "Shared theme", accent: "#1f6f5c" } });
    expect((await settings()).baseThemeId).toBe((imported.json.theme as { id: string }).id);

    expect(await tool("save_theme", { theme_file: "{ not json" })).toMatchObject({ isError: true, text: "That file isn't a Dossier theme." });
    expect(await tool("save_theme", { theme_file: JSON.stringify({ ...file, theme: { ...file.theme, bodyFont: "PAPYRUS" } }) })).toMatchObject({
      isError: true,
      text: "That theme uses a font Dossier doesn't have (PAPYRUS).",
    });
    expect(await tool("save_theme", { theme_file: JSON.stringify(file), accent: "#000000" })).toMatchObject({ isError: true });
    expect(await prisma().theme.count({ where: { builtIn: false } })).toBe(1);
  });

  it("deletes a custom theme: its documents lose the link, and the base falls back to Editorial", async () => {
    const copy = (await tool("save_theme", { based_on: "modern" })).json.theme as { id: string };
    const ledgerly = await prisma().application.findFirstOrThrow({ where: { company: "Ledgerly" } });
    await prisma().document.updateMany({ where: { applicationId: ledgerly.id }, data: { themeId: copy.id } });

    expect(await tool("save_theme", { id: copy.id, delete: true, accent: "#000000" })).toMatchObject({ isError: true, text: "To delete a theme, give only its id and delete: true." });
    expect(await tool("save_theme", { delete: true })).toMatchObject({ isError: true });
    expect((await tool("save_theme", { id: copy.id, delete: true })).json).toEqual({
      message: "Deleted “Modern copy”.",
      base_theme: { id: "editorial", name: "Editorial" },
      link: "https://dossier.example/resume",
    });
    expect(await prisma().theme.findUnique({ where: { id: copy.id } })).toBeNull();
    expect(await prisma().document.count({ where: { applicationId: ledgerly.id, themeId: null } })).toBe(2);
    expect((await settings()).baseThemeId).toBe("editorial");

    expect(await tool("save_theme", { id: "editorial", delete: true })).toMatchObject({ isError: true, text: "Built-in themes can't be deleted." });
    expect(await tool("save_theme", { id: copy.id, delete: true })).toMatchObject({ isError: true, text: THEME_GONE });
  });
});

describe("get_settings and update_settings", () => {
  it("tells every setting by its section, keys only by whether they're saved", async () => {
    await saveSettings({
      provider: "ANTHROPIC",
      model: "claude-opus-5-5",
      apiKeyEnc: encryptApiKey("sk-ant-secret"),
      jobSource: "JSEARCH",
      jsearchKeyEnc: encryptSecret(JOB_SOURCE_KEY, "ak_secret"),
      adzunaAppId: "app-1",
      googleClientId: "1234-client.apps.googleusercontent.com",
      googleClientSecretEnc: encryptSecret(GOOGLE_CLIENT_SECRET, "gcs_secret"),
      gmailInterval: 30,
      docLanguage: "German",
      customLanguages: ["Hebrew"],
    });
    const read = await tool("get_settings");
    expect(read.json).toMatchObject({
      ai: { ai_provider: "ANTHROPIC", provider_name: "Anthropic", ai_address: "https://api.anthropic.com", ai_model: "claude-opus-5-5", api_key: "set", ready: true, creativity: "BALANCED", never_invent_experience: true },
      job_search: { job_source: "JSEARCH", jsearch_host: "openwebninja", jsearch_key: "set", serpapi_key: "none", adzuna_app_id: "app-1", adzuna_key: "none", jooble_key: "none", arbeitsagentur: { offered: true, understood: false } },
      documents: { paper: "A4", document_language: "German", resume_language: "English", page_limit: "2", languages: expect.arrayContaining(["English", "German", "Hebrew"]) },
      your_data: { nightly_backup: true, last_backup: null, keep_task_data_hours: 24 },
      // Set up, but no account connected yet.
      google: { status: "disconnected", gmail_read: true, gmail_interval: 30, calendar_id: "primary", work_start: "09:00", work_time_zone: "" },
      about: { version: appVersion, check_for_updates_daily: true, newer_version: null },
      link: "https://dossier.example/settings",
    });
    expect((read.json.job_search as Record<string, unknown>).problem).toBeUndefined();
    const stored = await settings();
    for (const secret of ["sk-ant-secret", "ak_secret", "gcs_secret", stored.apiKeyEnc!, stored.jsearchKeyEnc!, stored.googleClientSecretEnc!, "1234-client"]) {
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
      page_limit: "1",
      resume_language: "German",
      file_name_pattern: "{name} – {doc}",
      keep_task_data_hours: 168,
      check_for_updates_daily: false,
    });
    expect(changed.json).toMatchObject({
      saved: ["creativity", "never_invent_experience", "paper", "resume_language", "file_name_pattern", "page_limit", "keep_task_data_hours", "check_for_updates_daily"],
      ai: { creativity: "EXPRESSIVE", never_invent_experience: false, show_what_changed: true },
      documents: { paper: "LETTER", page_limit: "1", resume_language: "German", file_name_pattern: "{name} – {doc}" },
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
      pageLimit: "1",
      resumeLanguage: "German",
      fileNamePattern: "{name} – {doc}",
      jobRetentionHours: 168,
      updateCheck: false,
      nightlyBackup: true,
    });

    // A new language goes on the list, as "Other language…" adds it; one there already, in any case, is picked.
    expect((await tool("update_settings", { document_language: " Hebrew " })).json).toMatchObject({ documents: { document_language: "Hebrew" }, link: "https://dossier.example/settings?section=documents" });
    await tool("update_settings", { document_language: "HEBREW", resume_language: "English", nightly_backup: false });
    expect(await settings()).toMatchObject({ docLanguage: "Hebrew", customLanguages: ["Hebrew"], resumeLanguage: null, nightlyBackup: false });
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

    // At the card's address: another server is the user's to set.
    const local = await tool("update_settings", { ai_provider: "LOCAL", ai_model: "qwen2.5:3b" });
    expect(local.json).toMatchObject({ ai: { ai_provider: "LOCAL", ai_address: "http://localhost:11434", ai_model: "qwen2.5:3b", ready: true } });
    expect(local.json).not.toHaveProperty("next");
  });

  it("chooses the job source, never ticking the Bundesagentur für Arbeit's note for the user (#223)", async () => {
    const refused = await tool("update_settings", { job_source: "ARBEITSAGENTUR", paper: "LETTER" });
    expect(refused).toMatchObject({ isError: true, text: expect.stringContaining("“I understand”") });
    // Nothing else changed either.
    expect(await settings()).toMatchObject({ jobSource: null, paper: "A4" });

    const jsearch = await tool("update_settings", { job_source: "JSEARCH", jsearch_host: "rapidapi", adzuna_app_id: " app-1 " });
    expect(jsearch.json).toMatchObject({
      job_search: { job_source: "JSEARCH", jsearch_host: "rapidapi", adzuna_app_id: "app-1", jsearch_key: "none", problem: "Add your JSearch key in Settings → Job search first." },
      link: "https://dossier.example/settings?section=jobs",
    });
    expect(await settings()).toMatchObject({ jobSource: "JSEARCH", jsearchHost: "rapidapi", adzunaAppId: "app-1" });

    // Once the user ticked it in Settings, switching back needs nothing more.
    await saveSettings({ arbeitsagenturAcceptedAt: "2026-10-20T08:00:00.000Z" });
    expect((await tool("update_settings", { job_source: "ARBEITSAGENTUR" })).json).toMatchObject({ job_search: { job_source: "ARBEITSAGENTUR", arbeitsagentur: { understood: true } } });
    await tool("update_settings", { job_source: "OFF", adzuna_app_id: "" });
    expect(await settings()).toMatchObject({ jobSource: "OFF", adzunaAppId: null });

    // A server can turn it off (DOSSIER_JOBS_ARBEITSAGENTUR=off).
    fakeEnv.DOSSIER_JOBS_ARBEITSAGENTUR = "off";
    expect(await tool("update_settings", { job_source: "ARBEITSAGENTUR" })).toMatchObject({ isError: true, text: "The Bundesagentur für Arbeit isn't offered on this server." });
    expect((await settings()).jobSource).toBe("OFF");
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
      { ai_address: "https://evil.example", job_source: "JSEARCH", paper: "LETTER" },
    ]) {
      expect(await tool("update_settings", change), JSON.stringify(change)).toMatchObject({ isError: true, text: ANOTHER_SERVER });
    }
    expect(await settings()).toMatchObject({ provider: "ANTHROPIC", baseUrl: null, model: "claude-opus-5-5", jobSource: null, paper: "A4" });
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

  it("tests the job source with its key", async () => {
    expect((await tool("test_connection", { connection: "job_source" })).json).toMatchObject({ job_source: "OFF", connected: false, problem: "Choose a source first." });
    await saveSettings({ jobSource: "JSEARCH", jsearchKeyEnc: encryptSecret(JOB_SOURCE_KEY, "ak_secret") });
    const requests = stubFetch(() => json(jsearchV2LastPage));
    expect((await tool("test_connection", { connection: "job_source" })).json).toMatchObject({ job_source: "JSEARCH", connected: true, seconds: expect.any(Number) });
    expect(requests[0].headers.get("x-api-key")).toBe("ak_secret");
    stubFetch(() => json({}, { status: 401 }));
    expect((await tool("test_connection", { connection: "job_source" })).json).toMatchObject({ connected: false, problem: "JSearch didn't accept your key. Check it in Settings → Job search." });
    expect(await tool("test_connection", { connection: "gmail" })).toMatchObject({ isError: true });
  });
});

describe("your data", () => {
  it("zips every tailored document in the background, and says when there's none", async () => {
    expect((await tool("zip_all_pdfs")).json).toEqual({ task_id: "zip-job", status: "started", documents: 2, next: "Call check_task with this task_id until it's done." });
    expect(startJob).toHaveBeenCalledWith(zipPdfsJob, {});
    await prisma().document.deleteMany();
    expect(await tool("zip_all_pdfs")).toMatchObject({ isError: true, text: "There are no tailored documents to download yet." });
    expect(startJob).toHaveBeenCalledTimes(1);
  });

  it("exports everything as the Export button does, as an embedded file without API keys", async () => {
    await saveSettings({ provider: "ANTHROPIC", apiKeyEnc: encryptApiKey("sk-ant-secret"), jsearchKeyEnc: encryptSecret(JOB_SOURCE_KEY, "ak_secret"), paper: "LETTER" });
    const exported = await tool("export_data");
    expect(exported.isError).toBe(false);
    const [about, file] = exported.content;
    expect(file).toMatchObject({ type: "resource", resource: { uri: expect.stringMatching(/^dossier:\/\/export\/dossier-export-\d{4}-\d{2}-\d{2}\.json$/), mimeType: "application/json" } });
    const text = file.type === "resource" ? file.resource.text : "";
    expect(JSON.parse(about.type === "text" ? about.text : "")).toEqual({
      file: expect.stringMatching(/^dossier-export-\d{4}-\d{2}-\d{2}\.json$/),
      size: expect.stringMatching(/^\d+ KB$/),
      bytes: Buffer.byteLength(text),
      applications: await prisma().application.count(),
      link: "https://dossier.example/settings?section=data",
    });

    const data = exportSchema.parse(JSON.parse(text));
    expect(data.applications.length).toBe(await prisma().application.count());
    expect(data.settings).toContainEqual({ key: "paper", value: "LETTER" });
    expect(data).not.toHaveProperty("apiKey");
    expect(data).not.toHaveProperty("jobSourceKeys");
    const stored = await settings();
    for (const secret of ["sk-ant-secret", "ak_secret", stored.apiKeyEnc!, stored.jsearchKeyEnc!, "connectorEnabledAt"]) expect(text).not.toContain(secret);
  });

  it("answers a big export with its size only, for Export in Settings to download", async () => {
    // A profile photo as the profile keeps it: a data URL, here of 600 KB.
    await prisma().profileField.create({ data: { key: "photo", value: `data:image/jpeg;base64,/9j/${"A".repeat(600_000)}` } });
    const exported = await tool("export_data");
    expect(exported.isError).toBe(false);
    expect(exported.content).toHaveLength(1);
    expect(exported.json).toEqual({
      file: expect.stringMatching(/^dossier-export-\d{4}-\d{2}-\d{2}\.json$/),
      size: expect.stringMatching(/^\d+ KB$/),
      bytes: expect.any(Number),
      applications: await prisma().application.count(),
      link: "https://dossier.example/settings?section=data",
      next: "It's too big to hand over in a chat. The user downloads it with Export in Settings → Your data.",
    });
    expect(exported.json.bytes).toBeGreaterThan(600_000);
    expect(exported.text).not.toContain("/9j/");
  });
});

describe("check_for_updates (E10-9)", () => {
  const release = (version: string) => vi.fn(async () => Response.json({ tag_name: `v${version}`, html_url: `https://github.com/AienTech/dossier/releases/tag/v${version}` }));

  it("says whether a newer release is out, and keeps it for the sidebar", async () => {
    vi.stubGlobal("fetch", release("99.0.0"));
    expect((await tool("check_for_updates")).json).toEqual({
      status: "newer",
      version: "99.0.0",
      current_version: appVersion,
      whats_new: "https://github.com/AienTech/dossier/releases/tag/v99.0.0",
      how_to_update: expect.stringMatching(/^https:\/\/github\.com\//),
      link: "https://dossier.example/settings?section=about",
    });
    expect(await settings()).toMatchObject({ latestVersion: "99.0.0" });

    vi.stubGlobal("fetch", release("0.0.1"));
    expect((await tool("check_for_updates")).json).toMatchObject({ status: "latest", version: appVersion, message: "You're on the latest version." });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    expect(await tool("check_for_updates")).toMatchObject({ isError: true, text: "Couldn't check for updates right now. Try again later." });
  });
});

describe("the tools' hints", () => {
  it("marks reads as read-only, and what can't be undone or reaches out as such", async () => {
    const { tools } = (await rpc("tools/list")) as { tools: { name: string; description: string; annotations?: Record<string, boolean> }[] };
    const hints = Object.fromEntries(tools.map((entry) => [entry.name, entry.annotations ?? {}]));
    for (const name of ["list_themes", "get_settings", "export_data"]) expect(hints[name], name).toEqual({ readOnlyHint: true, openWorldHint: false });
    for (const name of ["list_ai_models", "test_connection"]) expect(hints[name], name).toEqual({ readOnlyHint: true, openWorldHint: true });
    expect(hints.set_base_theme).toEqual({ readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    // Deleting a custom theme, and switching the AI provider, which removes its key, can't be undone.
    expect(hints.save_theme).toEqual({ readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false });
    expect(hints.update_settings).toEqual({ readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false });
    expect(hints.zip_all_pdfs).toEqual({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false });
    expect(hints.check_for_updates).toEqual({ readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true });
    // The export holds contact details and private notes: only for a file the user asked for.
    expect(tools.find((entry) => entry.name === "export_data")?.description).toContain("Only when the user asks for an export or backup file");
  });
});
