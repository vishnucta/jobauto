import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { toast } from "@/components/toast";
import type { SavedAgentSearch } from "@/lib/agent/search";

import { deleteRecurringSearch, moveRecurringSearch, saveAgentSettings, saveRecurringSearch, setRecurringSearchEnabled } from "../agent/actions";
import { saveAlertAddress, testAlert } from "./actions";
import { AgentSection, type AgentSettings } from "./agent-section";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("../agent/actions", () => ({
  saveAgentSettings: vi.fn(async () => ({ ok: true, data: null })),
  saveRecurringSearch: vi.fn(), moveRecurringSearch: vi.fn(), deleteRecurringSearch: vi.fn(), setRecurringSearchEnabled: vi.fn(),
}));
vi.mock("./actions", () => ({
  saveAlertAddress: vi.fn(async ({ address }: { address: string | null }) => ({ ok: true, data: { address } })),
  testAlert: vi.fn(async () => ({ ok: true, data: null })),
  updateSettings: vi.fn(async () => ({ ok: true, data: null })),
}));
vi.mock("@/components/toast", () => ({ toast: vi.fn(), toastResult: (result: { ok: boolean; error?: string }) => (result.ok ? result : (toast(result.error!), result)) }));

const initial: AgentSettings = { enabled: false, hour: 7, minScore: 70, maxScores: 15, maxDrafts: 3, autoDraft: false };
const search: SavedAgentSearch = { id: "one", name: "Data roles", query: { keywords: "Data scientist", place: "Berlin", country: "de", radiusKm: 25, remoteOnly: false, postedWithin: "any" }, enabled: true, sort: 0, createdAt: new Date(), updatedAt: new Date() };
const countries = [{ code: "de", name: "Germany" }, { code: "nl", name: "Netherlands" }];
const alerts = { address: null, minScore: 80, problem: null };
const open = (props: Partial<Parameters<typeof AgentSection>[0]> = {}) => render(<AgentSection initial={initial} alerts={alerts} searches={[search]} source="JSEARCH" scoring={{ scorer: "AI", ready: true }} countries={countries} timeZone="Europe/Berlin" {...props} />);

beforeEach(() => vi.clearAllMocks());

describe("Settings → Job agent", () => {
  it("adopts refreshed search snapshots without losing an open editor draft", async () => {
    const user = userEvent.setup();
    const props = { initial, alerts, searches: [search], source: "JSEARCH" as const, scoring: { scorer: "AI" as const, ready: true }, countries, timeZone: "Europe/Berlin" };
    const { rerender } = render(<AgentSection {...props} />);
    await user.click(screen.getByRole("button", { name: "Edit Data roles" }));
    await user.type(screen.getByLabelText("What"), " unsaved");
    const refreshed = { ...search, name: "Updated elsewhere" };
    rerender(<AgentSection {...props} searches={[refreshed]} />);
    expect(screen.getByRole("switch", { name: "Updated elsewhere" })).toBeInTheDocument();
    expect(screen.getByLabelText("What")).toHaveValue("Data scientist unsaved");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    rerender(<AgentSection {...props} searches={[]} />);
    expect(screen.queryByRole("switch", { name: "Updated elsewhere" })).not.toBeInTheDocument();
    expect(screen.getByText("Recurring searches (0/3)")).toBeInTheDocument();
  });

  it("says on this computer that it only runs while Dossier is open (#325)", () => {
    open({ initial: { ...initial, enabled: true }, onlyWhileOpen: true });
    expect(screen.getByRole("switch", { name: "Run the job agent" })).toHaveAccessibleDescription(
      /On this computer, only while Dossier is open: when it's closed at that hour, the run starts once you open it, the same day\.$/,
    );
  });

  it("allows duplicate names and distinguishes their accessible controls by position", async () => {
    const user = userEvent.setup();
    const second = { ...search, id: "two", sort: 1, query: { ...search.query, keywords: "Designer" } };
    open({ searches: [search, second] });
    expect(screen.getByRole("switch", { name: "Data roles (search 1)" })).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Data roles (search 2)" })).toBeInTheDocument();
    vi.mocked(moveRecurringSearch).mockResolvedValueOnce({ ok: true, data: [second, search] });
    await user.click(screen.getByRole("button", { name: "Move up: Data roles (search 2)" }));
    expect(moveRecurringSearch).toHaveBeenCalledWith({ id: "two", direction: "up" });
    await user.click(screen.getByRole("button", { name: "Edit Data roles (search 1)" }));
    expect(screen.getByLabelText("What")).toHaveValue("Designer");
  });

  it("saves shared settings without a query bridge and explains the shared request and AI budgets", async () => {
    const user = userEvent.setup(); open();
    await user.click(screen.getByRole("switch", { name: "Run the job agent" }));
    expect(saveAgentSettings).toHaveBeenLastCalledWith({ enabled: true });
    await user.selectOptions(screen.getByLabelText("Runs after"), "09:00");
    expect(saveAgentSettings).toHaveBeenLastCalledWith({ hour: 9 });
    await user.selectOptions(screen.getByLabelText("Minimum score"), "80 of 100");
    expect(saveAgentSettings).toHaveBeenLastCalledWith({ minScore: 80 });
    expect(screen.getByText(/One shared daily schedule/)).toHaveTextContent("including failed attempts. A run waits until the whole batch fits. Across all searches, each run scores up to 15 postings");
    expect(screen.getByLabelText("Drafts per run, at most")).toBeDisabled();
    await user.click(screen.getByRole("switch", { name: "Prepare drafts on its own" }));
    await user.selectOptions(screen.getByLabelText("Drafts per run, at most"), "5");
    expect(saveAgentSettings).toHaveBeenLastCalledWith({ maxDrafts: 5 });
  });

  it("creates explicitly, validates before saving and can cancel without changing data", async () => {
    const user = userEvent.setup(); open({ searches: [], suggestedQuery: search.query });
    await user.click(screen.getByRole("button", { name: "Add search" }));
    await user.click(screen.getByRole("button", { name: "Save search" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Give the search a name.");
    expect(saveRecurringSearch).not.toHaveBeenCalled();
    await user.type(screen.getByLabelText("Search name"), "Data roles");
    vi.mocked(saveRecurringSearch).mockResolvedValueOnce({ ok: true, data: search });
    await user.click(screen.getByRole("button", { name: "Save search" }));
    expect(saveRecurringSearch).toHaveBeenCalledWith({ id: undefined, name: "Data roles", query: search.query, enabled: true, sort: 0 });
    expect(await screen.findByRole("switch", { name: "Data roles" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Edit Data roles" }));
    await user.clear(screen.getByLabelText("Search name"));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("switch", { name: "Data roles" })).toBeInTheDocument();
  });

  it("edits a stable id, disables a search and preserves values on failed saves", async () => {
    const user = userEvent.setup(); open();
    vi.mocked(saveRecurringSearch).mockResolvedValueOnce({ ok: false, error: "Not saved" });
    await user.click(screen.getByRole("button", { name: "Edit Data roles" }));
    await user.type(screen.getByLabelText("What"), " NLP");
    await user.click(screen.getByRole("button", { name: "Save search" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Not saved");
    expect(screen.getByLabelText("What")).toHaveValue("Data scientist NLP");
    vi.mocked(saveRecurringSearch).mockResolvedValueOnce({ ok: true, data: { ...search, query: { ...search.query, keywords: "Data scientist NLP" } } });
    await user.click(screen.getByRole("button", { name: "Save search" }));
    expect(saveRecurringSearch).toHaveBeenLastCalledWith(expect.objectContaining({ id: "one", query: expect.objectContaining({ keywords: "Data scientist NLP" }) }));
    vi.mocked(setRecurringSearchEnabled).mockResolvedValueOnce({ ok: true, data: { ...search, enabled: false } });
    await user.click(screen.getByRole("switch", { name: "Data roles" }));
    await waitFor(() => expect(screen.getByRole("switch", { name: "Data roles" })).toHaveAttribute("aria-checked", "false"));
    expect(setRecurringSearchEnabled).toHaveBeenCalledWith({ id: search.id, enabled: false });
  });

  it("points to the source or AI provider while one isn't set up", () => {
    const { unmount } = open({ source: null });
    expect(screen.getByRole("note")).toHaveTextContent("The agent searches the source you choose in Settings → Job search, which is off. Choose one first.");
    expect(screen.getByRole("link", { name: "Settings → Job search" })).toHaveAttribute("href", "/settings?section=jobs");
    unmount();
    open({ scoring: { scorer: "AI", ready: false } });
    expect(screen.getByRole("note")).toHaveTextContent("The agent scores postings with the AI provider in Settings → AI provider, which isn't set up yet. Choose one first.");
    expect(screen.getByRole("link", { name: "Settings → AI provider" })).toHaveAttribute("href", "/settings?section=ai");
  });

  it("asks for the TypeSafe key when Jev scores without one (#274)", () => {
    open({ scoring: { scorer: "JEV", ready: false } });
    expect(screen.getByRole("note")).toHaveTextContent("The agent scores postings with Jev, which needs your TypeSafe key in Settings → Scoring.");
    expect(screen.getByRole("link", { name: "Settings → Scoring" })).toHaveAttribute("href", "/settings?section=scoring");
  });

  it("says it doesn't search the Bundesagentur für Arbeit (#223)", () => {
    open({ source: "ARBEITSAGENTUR" });
    expect(screen.getByRole("note")).toHaveTextContent("The agent doesn't search the Bundesagentur für Arbeit. Choose JSearch, SerpApi, Adzuna or FreeHire in Settings → Job search for it.");
    expect(screen.getByRole("link", { name: "Settings → Job search" })).toHaveAttribute("href", "/settings?section=jobs");
  });

  it("caps at three including disabled searches, moves accessibly and confirms deletion", async () => {
    const user = userEvent.setup();
    const second = { ...search, id: "two", name: "Second", sort: 1 };
    const third = { ...search, id: "three", name: "Third", enabled: false, sort: 2 };
    open({ searches: [search, second, third] });
    expect(screen.getByRole("button", { name: "Add search" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Move up: Data roles" })).toBeDisabled();
    vi.mocked(moveRecurringSearch).mockResolvedValueOnce({ ok: true, data: [second, search, third] });
    await user.click(screen.getByRole("button", { name: "Move up: Second" }));
    expect(moveRecurringSearch).toHaveBeenCalledWith({ id: "two", direction: "up" });
    expect(screen.getByRole("button", { name: "Move up: Second" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Delete Third" }));
    expect(deleteRecurringSearch).not.toHaveBeenCalled();
    const dialog = screen.getByRole("alertdialog");
    expect(dialog).toHaveTextContent("Existing candidates and their historical search labels stay");
    vi.mocked(deleteRecurringSearch).mockResolvedValueOnce({ ok: true, data: null });
    await user.click(within(dialog).getByRole("button", { name: "Delete search" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Add search" })).toBeEnabled());
  });

  it("warns for Bundesagentur without disabling manual search and points to missing global providers", () => {
    const { unmount } = open({ source: "ARBEITSAGENTUR" });
    expect(screen.getByRole("note")).toHaveTextContent("Manual Find jobs searches are unaffected.");
    unmount(); open({ source: null });
    expect(screen.getByRole("link", { name: "Settings → Job search" })).toHaveAttribute("href", "/settings?section=jobs");
  });

  it("rolls back a rejected shared setting change", async () => {
    const user = userEvent.setup(); open();
    vi.mocked(saveAgentSettings).mockResolvedValueOnce({ ok: false, error: "Enable a search first." });
    await user.click(screen.getByRole("switch", { name: "Run the job agent" }));
    await waitFor(() => expect(screen.getByRole("switch", { name: "Run the job agent" })).toHaveAttribute("aria-checked", "false"));
    expect(toast).toHaveBeenCalledWith("Enable a search first.");
  });

  it("saves an ntfy topic for phone alerts, sends a test, and turns them off", async () => {
    const user = userEvent.setup();
    open();
    expect(screen.getByText("Off. Nothing is sent until a topic is saved.")).toBeInTheDocument();
    await user.type(screen.getByLabelText("Topic address"), "not an address");
    expect(screen.getByText("An address such as https://ntfy.sh/your-topic")).toBeInTheDocument();
    await user.clear(screen.getByLabelText("Topic address"));
    await user.click(screen.getByRole("button", { name: "Make one up" }));
    expect((screen.getByLabelText("Topic address") as HTMLInputElement).value).toMatch(/^https:\/\/ntfy\.sh\/jobauto-[a-z2-9]{16}$/);
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(saveAlertAddress).toHaveBeenCalledWith({ address: expect.stringMatching(/^https:\/\/ntfy\.sh\/jobauto-/) });
    await user.click(await screen.findByRole("button", { name: "Send a test" }));
    expect(testAlert).toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Turn off" }));
    expect(saveAlertAddress).toHaveBeenLastCalledWith({ address: null });
    expect(await screen.findByText("Off. Nothing is sent until a topic is saved.")).toBeInTheDocument();
  });

  it("says why the last alert didn't go out", () => {
    open({ alerts: { address: "https://ntfy.sh/jobauto-abc", minScore: 85, problem: "ntfy.sh couldn't be reached." } });
    expect(screen.getByRole("note")).toHaveTextContent("The last alert didn't go out: ntfy.sh couldn't be reached.");
    expect(screen.getByLabelText("Alert about agent matches scored at least")).toHaveValue("85");
  });
});
