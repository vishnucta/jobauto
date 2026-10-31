import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/env", () => ({ env: { DOSSIER_SECRET: "s".repeat(40), DOSSIER_PASSWORD: "argon2id:m=19456,t=2,p=1:c2FsdA:aGFzaA" } }));
const settings = vi.hoisted(() => ({ connectorEnabledAt: "2026-10-23T09:00:00.000Z" as string | null }));
vi.mock("@/lib/settings-data", () => ({ loadSettings: async () => settings }));
const db = vi.hoisted(() => ({ postingSearch: { findUnique: vi.fn() }, postingScore: { upsert: vi.fn() } }));
vi.mock("@/lib/prisma", () => ({ prisma: db }));
vi.mock("@/lib/ai/config", () => ({ isAiUsable: async () => false }));
vi.mock("@/lib/profile-data", async () => {
  const { demoProfile } = await import("@/lib/demo-profile");
  return { loadProfile: async () => demoProfile() };
});
const searches = vi.hoisted(() => ({ ran: [] as unknown[] }));
vi.mock("@/lib/posting-searches", () => ({
  runSearch: async (query: unknown) => (searches.ran.push(query), { ok: true, id: "s1" }),
  loadSearch: async () => ({ id: "s1", postings: [], next: null }),
  showMoreFor: async () => ({ ok: true, postings: [], next: null }),
}));

import { demoProfile } from "@/lib/demo-profile";
import { challengeOf, exchangeCode, issueCode, registerClient } from "@/lib/connector/oauth";

import { GET, POST } from "./route";

const CLAUDE = "https://claude.ai/api/mcp/auth_callback";

async function accessToken(): Promise<string> {
  const clientId = await registerClient({ name: "Claude", redirectUris: [CLAUDE] });
  const verifier = "v".repeat(50);
  const code = await issueCode({ clientId, redirectUri: CLAUDE, codeChallenge: challengeOf(verifier), resource: "" });
  return (await exchangeCode({ code, clientId, redirectUri: CLAUDE, verifier })).access_token;
}

const call = (body: unknown, token?: string) =>
  POST(
    new Request("https://dossier.example/api/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-06-18",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    }),
  );

/** The answer to one JSON-RPC call, whether it came as JSON or as one server-sent event. */
async function answer(response: Response): Promise<{ result?: { content?: { text: string }[]; isError?: boolean; tools?: { name: string; annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean } }[]; serverInfo?: unknown }; error?: unknown }> {
  const body = await response.text();
  const data = body.trimStart().startsWith("{") ? body : body.split("\n").find((line) => line.startsWith("data: "))!.slice("data: ".length);
  return JSON.parse(data);
}

const tool = async (name: string, args: Record<string, unknown>) => {
  const { result } = await answer(await call({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name, arguments: args } }, await accessToken()));
  return { isError: result?.isError ?? false, text: result?.content?.[0]?.text ?? "" };
};

beforeEach(() => {
  settings.connectorEnabledAt = "2026-10-23T09:00:00.000Z";
  searches.ran = [];
});

describe("the Claude connector at /api/mcp (#221)", () => {
  it("isn't there while the connector is off", async () => {
    const token = await accessToken();
    settings.connectorEnabledAt = null;
    expect((await call({ jsonrpc: "2.0", id: 1, method: "tools/list" }, token)).status).toBe(404);
    expect((await GET(new Request("https://dossier.example/api/mcp"))).status).toBe(404);
  });

  it("asks Claude to sign in, and says where to find out how", async () => {
    const response = await call({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe(
      'Bearer resource_metadata="https://dossier.example/.well-known/oauth-protected-resource/api/mcp", scope="dossier"',
    );
    expect((await call({ jsonrpc: "2.0", id: 1, method: "tools/list" }, "not-a-token")).status).toBe(401);
  });

  it("answers MCP with Dossier's tools once signed in, and marks the ones that send or delete", async () => {
    const token = await accessToken();
    const init = await call(
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } },
      token,
    );
    expect(init.status).toBe(200);
    expect(await answer(init)).toMatchObject({ result: { serverInfo: { name: "dossier" } } });

    const { result } = await answer(await call({ jsonrpc: "2.0", id: 2, method: "tools/list" }, token));
    const tools = result?.tools ?? [];
    // The jobauto fork's tools cover what the screens do (src/lib/connector/tools/*).
    expect(tools.map((entry) => entry.name).sort()).toEqual([
      "act_on_agent_find",
      "add_match_skill",
      "cancel_task",
      "check_draft",
      "check_for_updates",
      "check_inbox",
      "check_task",
      "confirm_interview",
      "delete_application",
      "draft_application",
      "draft_email_reply",
      "edit_document",
      "edit_profile_items",
      "export_data",
      "export_pdf",
      "find_free_slots",
      "finish_profile_import",
      "get_application",
      "get_apply_status",
      "get_document",
      "get_job_agent",
      "get_posting",
      "get_profile",
      "get_settings",
      "import_profile_from_resume",
      "list_ai_models",
      "list_applications",
      "list_emails",
      "list_notes",
      "list_postings",
      "list_startups",
      "list_themes",
      "more_jobs",
      "read_email",
      "refresh_startups",
      "remove_profile_entry",
      "remove_search",
      "remove_startup",
      "retry_task",
      "rewrite_document",
      "save_application",
      "save_apply_answers",
      "save_email_reply",
      "save_job_scores",
      "save_note",
      "save_profile_entry",
      "save_theme",
      "score_with_dossier",
      "search_jobs",
      "send_application_email",
      "send_email_reply",
      "set_application_status",
      "set_base_theme",
      "set_document_look",
      "settle_apply",
      "sort_profile_entries",
      "start_apply",
      "test_connection",
      "undo_status_change",
      "update_application",
      "update_email",
      "update_google_settings",
      "update_job_agent",
      "update_postings",
      "update_profile_basics",
      "update_settings",
      "update_startup",
      "write_application_email",
      "zip_all_pdfs",
    ]);
    // Reading never changes anything, and every tool that sends or deletes says so, for Claude to ask first.
    for (const entry of tools.filter(({ name }) => /^(get|list|read)_/.test(name))) expect(entry.annotations?.readOnlyHint, entry.name).toBe(true);
    for (const entry of tools.filter(({ name }) => /^(send|delete|remove)_/.test(name))) expect(entry.annotations?.destructiveHint, entry.name).toBe(true);
  });

  it("gives Claude the profile without contact details", async () => {
    const { isError, text } = await tool("get_profile", {});
    expect(isError).toBe(false);
    const profile = JSON.parse(text) as Record<string, unknown>;
    expect(profile).toMatchObject({ name: demoProfile().basics.name, link: "https://dossier.example/profile" });
    expect(text).not.toContain(demoProfile().basics.email);
    expect(text).not.toContain(demoProfile().basics.phone || "no phone");
  });

  it("searches the profile's city and country by default", async () => {
    const { isError, text } = await tool("search_jobs", { keywords: "product designer" });
    expect(isError).toBe(false);
    const { city } = demoProfile().basics;
    expect(searches.ran.at(-1)).toMatchObject({ keywords: "product designer", place: city, radiusKm: 25, remoteOnly: false, postedWithin: "month" });
    expect(JSON.parse(text)).toMatchObject({ search_id: "s1", searched: `product designer in ${city}`, link: "https://dossier.example/jobs?search=s1" });
  });

  it("asks Claude to write the application itself when Dossier has no AI model", async () => {
    const { isError, text } = await tool("draft_application", { posting_text: "Product designer at Acme" });
    expect(isError).toBe(true);
    expect(text).toContain("save_application");
  });

  it("saves the fit scores Claude gives postings, so Find jobs shows them", async () => {
    const posting = { source: "JSEARCH", externalId: "j1", title: "Product Designer", company: "Acme", place: "Berlin", remote: null, salary: "", postedAt: null, url: "", via: "", description: "Figma", complete: true };
    db.postingSearch.findUnique.mockResolvedValue({ postings: [posting] });
    const { text } = await tool("save_job_scores", {
      search_id: "s1",
      scores: [
        { number: 1, score: 78, reasons: ["Figma in the Acme role"] },
        { number: 9, score: 10, reasons: ["?"] },
      ],
    });
    expect(JSON.parse(text)).toMatchObject({ saved: [{ number: 1, score: 78 }], not_found: [9] });
    expect(db.postingScore.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: expect.objectContaining({ externalId: "j1", score: 78, reasons: ["Figma in the Acme role"], redFlags: [], scoredWith: "claude-chat" }) }),
    );
  });
});
