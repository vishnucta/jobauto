import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

import { fakeJobSearches, resetData, sql } from "./support";

test.beforeEach(resetData);
// Reset even on a failed assertion: no searches, candidates, attribution,
// applications or quota ledger should leak into the other specs.
test.afterEach(resetData);

async function addSearch(page: Page, name: string, keywords = "Agent browser designer") {
  await page.getByRole("button", { name: "Add search", exact: true }).click();
  await page.getByLabel("Search name", { exact: true }).fill(name);
  await page.getByLabel("What", { exact: true }).fill(keywords);
  await page.getByLabel("Country", { exact: true }).selectOption("nl");
  await page.getByRole("button", { name: "Save search", exact: true }).click();
  await expect(page.getByRole("switch", { name, exact: true })).toBeVisible();
}

const names = () => sql<{ id: string; name: string; enabled: boolean }>(`SELECT id, name, enabled FROM "AgentSearch" ORDER BY sort, "createdAt", id`);

async function accessible(page: Page) {
  const { violations } = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  expect(violations.filter(({ impact }) => impact === "serious" || impact === "critical")).toEqual([]);
}

async function mobile(page: Page) {
  // The app's sidebar is manually collapsible, not an automatic mobile drawer.
  // Exercise its real control so the 390px view leaves room for the content.
  const collapse = page.getByRole("button", { name: "Collapse sidebar", exact: true });
  if (await collapse.isVisible()) await collapse.click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("button", { name: "Expand sidebar", exact: true })).toBeVisible();
}

async function capture(page: Page, name: string) {
  // Focused editors scroll into view; reset before a full-page capture so
  // sticky headers aren't captured halfway down the document.
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
  await page.screenshot({ path: `/tmp/opencode/${name}.png`, fullPage: true });
}

test("multiple searches persist CRUD/order/toggles, enforce the cap across tabs, and report stale edits", async ({ page, context }) => {
  await page.goto("/settings?section=agent");
  await page.getByRole("button", { name: "Add search", exact: true }).click();
  await page.getByRole("button", { name: "Save search", exact: true }).click();
  await expect(page.getByRole("form", { name: "New recurring search" }).getByRole("alert")).toContainText("name");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await addSearch(page, "Design");
  await addSearch(page, "Remote");
  const original = await names();

  // A second tab opens an editor before the first tab fills the last slot.
  // Its eventual submit exercises the real server cap, not just disabled UI.
  const other = await context.newPage();
  await other.goto("/settings?section=agent");
  await other.getByRole("button", { name: "Add search", exact: true }).click();
  await other.getByLabel("Search name", { exact: true }).fill("Fourth");
  await other.getByLabel("What", { exact: true }).fill("Engineer");
  await other.getByLabel("Country", { exact: true }).selectOption("nl");
  await addSearch(page, "<script>literal</script>");
  await other.getByRole("button", { name: "Save search", exact: true }).click();
  await expect(other.getByRole("form").getByRole("alert")).toContainText("three");
  expect(await names()).toHaveLength(3);
  await other.close();
  await expect(page.getByRole("button", { name: "Add search", exact: true })).toBeDisabled();

  await page.getByRole("button", { name: "Edit Design", exact: true }).click();
  await page.getByLabel("Search name", { exact: true }).fill("Renamed design");
  await page.getByLabel("What", { exact: true }).fill("Senior designer");
  await page.getByRole("button", { name: "Save search", exact: true }).click();
  await expect(page.getByRole("switch", { name: "Renamed design", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Move up: Remote", exact: true }).click();
  await expect(page.getByRole("button", { name: "Move up: Remote", exact: true })).toBeDisabled();
  await page.getByRole("switch", { name: "Remote", exact: true }).click();
  await expect(page.getByRole("switch", { name: "Remote", exact: true })).toHaveAttribute("aria-checked", "false");
  await page.reload();
  expect(await names()).toEqual([
    { ...original[1], enabled: false }, { ...original[0], name: "Renamed design" },
    expect.objectContaining({ name: "<script>literal</script>", enabled: true }),
  ]);
  await expect(page.getByRole("switch", { name: "Remote", exact: true })).toHaveAttribute("aria-checked", "false");
  await expect(page.getByRole("link", { name: "Preview Renamed design in Find jobs" })).toHaveAttribute("href", /Senior\+designer/);

  await mobile(page);
  await accessible(page);
  const label = await page.getByText("<script>literal</script>", { exact: true }).boundingBox();
  const toggle = await page.getByRole("switch", { name: "<script>literal</script>", exact: true }).boundingBox();
  expect(label).not.toBeNull();
  expect(toggle).not.toBeNull();
  expect(label!.x + label!.width).toBeLessThanOrEqual(toggle!.x);
  await capture(page, "agent-searches-settings-mobile");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole("button", { name: "Delete Remote", exact: true }).click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText("historical search labels stay");
  await accessible(page);
  await dialog.getByRole("button", { name: "Delete search", exact: true }).click();
  await expect(page.getByRole("switch", { name: "Remote", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Add search", exact: true })).toBeEnabled();

  // A row removed elsewhere must not be recreated by an old editor.
  await page.getByRole("button", { name: "Edit Renamed design", exact: true }).click();
  await accessible(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await capture(page, "agent-searches-editor-mobile");
  await sql(`DELETE FROM "AgentSearch" WHERE id = $1`, [original[0].id]);
  await page.getByRole("button", { name: "Save search", exact: true }).click();
  await expect(page.getByRole("form").getByRole("alert")).toContainText("no longer exists");
  expect(await names()).toEqual([expect.objectContaining({ name: "<script>literal</script>" })]);
});

test("a stale tab toggles only enabled and validates the current query's country without overwriting edits", async ({ page, context }) => {
  await page.goto("/settings?section=agent");
  await addSearch(page, "Design");
  await addSearch(page, "Other");
  const [original] = await names();
  const other = await context.newPage();
  await other.goto("/settings?section=agent");
  await other.getByRole("button", { name: "Edit Design", exact: true }).click();
  await other.getByLabel("Search name", { exact: true }).fill("Renamed elsewhere");
  await other.getByLabel("What", { exact: true }).fill("Engineer");
  await other.getByLabel("Where", { exact: true }).fill("Utrecht");
  await other.getByRole("button", { name: "Save search", exact: true }).click();
  await expect(other.getByRole("switch", { name: "Renamed elsewhere", exact: true })).toBeVisible();
  await other.getByRole("button", { name: "Move down: Renamed elsewhere", exact: true }).click();
  await expect(other.getByRole("button", { name: "Move down: Renamed elsewhere", exact: true })).toBeDisabled();
  const currentRow = () => sql(`SELECT id, name, query, sort, enabled FROM "AgentSearch" WHERE id = $1`, [original.id]);
  const [edited] = await currentRow();
  expect(edited).toMatchObject({ name: "Renamed elsewhere", query: { keywords: "Engineer", place: "Utrecht", country: "nl" }, sort: 1, enabled: true });

  // This tab has not refreshed: its switch still carries the old name/query/order.
  await page.getByRole("switch", { name: "Design", exact: true }).click();
  await expect(page.getByRole("switch", { name: "Renamed elsewhere", exact: true })).toHaveAttribute("aria-checked", "false");
  expect(await currentRow()).toEqual([{ ...edited, enabled: false }]);
  await expect(page.getByRole("button", { name: "Move down: Renamed elsewhere", exact: true })).toBeDisabled();

  // Change the now-disabled query elsewhere. Enabling from the stale tab must
  // validate this CURRENT query/name, not restore its old valid country.
  await other.reload();
  await other.getByRole("button", { name: "Edit Renamed elsewhere", exact: true }).click();
  await other.getByLabel("Search name", { exact: true }).fill("Needs a country");
  await other.getByLabel("Country", { exact: true }).selectOption("");
  await other.getByRole("button", { name: "Save search", exact: true }).click();
  await expect(other.getByRole("switch", { name: "Needs a country", exact: true })).toHaveAttribute("aria-checked", "false");
  const [incomplete] = await currentRow();
  expect(incomplete).toMatchObject({ name: "Needs a country", query: { country: "", keywords: "Engineer", place: "Utrecht" }, sort: 1, enabled: false });
  await page.getByRole("switch", { name: "Renamed elsewhere", exact: true }).click();
  await expect(page.getByText("Choose a country for “Needs a country”.", { exact: true })).toBeVisible();
  expect(await currentRow()).toEqual([incomplete]);
  await expect(page.getByRole("switch", { name: "Renamed elsewhere", exact: true })).toHaveAttribute("aria-checked", "false");
  await other.close();
});

test("all searches share scores/quota, retain partial source results and immutable attribution in export", async ({ page }) => {
  await page.goto("/settings?section=agent");
  await addSearch(page, "Design");
  await addSearch(page, "Overlap", "Senior designer");
  await addSearch(page, "Unavailable", "agent-source-failure");
  await page.getByLabel("Postings scored per run", { exact: true }).selectOption("2");
  await expect(page.getByText("All changes saved")).toBeVisible();
  await page.getByRole("switch", { name: "Run the job agent", exact: true }).click();
  await expect(page.getByText("All changes saved")).toBeVisible();
  const before = await fakeJobSearches();
  await page.goto("/agent");
  await page.getByRole("button", { name: "Run all now", exact: true }).click();
  await expect(page.getByText(/Unavailable: JSearch isn't answering right now/).first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("button", { name: "Run all now", exact: true })).toBeVisible();
  expect(await fakeJobSearches()).toBe(before + 3);
  await expect(page.getByText("0 of 3 in the rolling 24-hour budget", { exact: true })).toBeVisible();
  await expect(page.getByText("Scored postings", { exact: true })).toBeVisible();
  expect(await sql(`SELECT count(*)::int AS count FROM "AgentCandidate"`)).toEqual([{ count: 2 }]);
  expect(await sql(`SELECT "searchName", count(*)::int AS count FROM "AgentCandidateSearch" GROUP BY "searchName" ORDER BY "searchName"`)).toEqual([{ searchName: "Design", count: 2 }, { searchName: "Overlap", count: 2 }]);
  await expect(page.getByText(/Unavailable: 0 found · 0 new to agent · Source request failed/)).toBeVisible();
  await expect(page.getByText(/Design: 3 found · 3 new to agent · Source request completed/)).toBeVisible();
  await expect(page.getByText(/Overlap: 3 found · 3 new to agent · Source request completed/)).toBeVisible();
  await page.getByRole("button", { name: "Run all now", exact: true }).click();
  await expect(page.getByText(/The agent needs 3 source requests, but may use only 3 in 24 hours/)).toBeVisible();
  expect(await fakeJobSearches()).toBe(before + 3);
  await accessible(page);
  await capture(page, "agent-searches-results-desktop");

  await page.goto("/settings?section=agent");
  await page.getByRole("button", { name: "Edit Design", exact: true }).click();
  await page.getByLabel("Search name", { exact: true }).fill("New design name");
  await page.getByRole("button", { name: "Save search", exact: true }).click();
  await expect(page.getByRole("switch", { name: "New design name", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Delete Overlap", exact: true }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete search", exact: true }).click();
  await expect(page.getByRole("switch", { name: "Overlap", exact: true })).toHaveCount(0);
  await page.goto("/agent");
  await expect(page.getByText("Run as “Design”", { exact: true })).toBeVisible();
  await expect(page.getByText(/Overlap \(deleted search\): 3 found/)).toBeVisible();
  const scored = page.getByRole("region", { name: "Scored postings" });
  await expect(scored.getByText("Found by: Design · Overlap (deleted search)", { exact: true })).toHaveCount(2);
  const response = await page.request.get("/api/export");
  expect(response.ok()).toBe(true);
  const exported = await response.json();
  expect(exported.schemaVersion).toBe(12);
  expect(exported.agentSearches.map((search: { name: string }) => search.name)).toEqual(["New design name", "Unavailable"]);
  expect(exported.agentCandidateSearches).toHaveLength(4);
  expect(exported.agentCandidateSearches.filter((link: { searchId: string | null }) => link.searchId === null)).toEqual([
    expect.objectContaining({ searchName: "Overlap" }), expect.objectContaining({ searchName: "Overlap" }),
  ]);
  expect(exported.settings.some((setting: { key: string }) => /agentRuns|agentQuery|KeyEnc/.test(setting.key))).toBe(false);
  await mobile(page);
  await accessible(page);
  await capture(page, "agent-searches-results-mobile");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

  await scored.getByRole("button", { name: "Dismiss", exact: true }).first().click();
  await expect(scored.getByText("Found by: Design · Overlap (deleted search)", { exact: true })).toHaveCount(1);
  const afterDismissal = await (await page.request.get("/api/export")).json();
  const dismissed = afterDismissal.agentCandidates.find((candidate: { status: string }) => candidate.status === "DISMISSED");
  expect(dismissed).toBeDefined();
  expect(afterDismissal.agentCandidateSearches).toHaveLength(2);
  expect(afterDismissal.agentCandidateSearches.some((link: { candidateId: string }) => link.candidateId === dismissed.id)).toBe(false);
});
