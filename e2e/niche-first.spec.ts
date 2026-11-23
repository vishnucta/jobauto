import { expect, test } from "@playwright/test";

import { FIRST_PROFILE, resetData, sql } from "./support";

// Niche first (jobauto fork): postings in her own field are marked by a word
// match in Positions, counted on the dashboard with why to read them first,
// offered in Do today ahead of general matches, and a few are scored on their
// own each day, a number Settings → Scoring changes. Made-up employers only.
/** Where a spec may leave screenshots to look at, when E2E_SHOTS names a folder. */
const SHOTS = process.env.E2E_SHOTS;

const TEXT = "Our reporting team works in English. You prepare the daily reports, look into breaks and work with the desk.";

/** A posting as Positions keeps it, found now. */
async function keep(id: string, title: string, company: string, extra: { description?: string; postedDaysAgo?: number | null } = {}) {
  const days = extra.postedDaysAgo === undefined ? 3 : extra.postedDaysAgo;
  await sql(
    `INSERT INTO "Posting" (id, source, "externalId", title, company, place, url, description, complete, "postedAt", "updatedAt")
     VALUES ($1, 'JSEARCH', $1, $2, $3, 'Hamburg', $4, $5, true, ${days === null ? "NULL" : `now() - interval '${days} days'`}, now())`,
    [id, title, company, `https://jobs.example/${id}`, extra.description ?? TEXT],
  );
}

test.beforeAll(async () => {
  await resetData();
  // Her profile is in regulatory reporting: postings in that field are marked.
  await sql(`UPDATE "Profile" SET headline = 'Regulatory Reporting Analyst' WHERE id = ${FIRST_PROFILE}`);
  // Her own drafts and the agent's finds would fill Today's three: without them a free slot goes to her field.
  await sql(`DELETE FROM "AgentCandidate"`);
  await sql(`DELETE FROM "Application" WHERE status = 'DRAFT'`);
  await keep("field-title", "Transaction Reporting Analyst", "Northwind Clearing");
  await keep("field-text", "Financial Analyst", "Ledgerly Bank", { description: `${TEXT} You own the EMIR and MiFIR reports.` });
  await keep("field-old", "Meldewesen Referent", "Harbour Trust", { postedDaysAgo: 45 });
  await keep("mention", "Accountant", "Quayside Foods", { description: "Monthly reconciliation of the bank accounts." });
});

test("marks postings in her field as a word match, and the Field filter narrows the list to them with the warning", async ({ page }) => {
  await page.goto("/jobs?sort=new");
  const list = page.getByRole("list", { name: "Postings" });
  await expect(list.getByRole("button", { name: /^Transaction Reporting Analyst/ })).toContainText("In your field (word match)");
  await expect(list.getByRole("button", { name: /^Financial Analyst/ })).toContainText("In your field (word match)");
  await expect(list.getByRole("button", { name: /^Accountant/ })).not.toContainText("In your field");
  await expect(list.getByRole("button", { name: /^Meldewesen Referent/ })).toContainText("Check it is still open");

  await page.getByRole("button", { name: /^Field: / }).click();
  await page.getByRole("menuitemradio", { name: "in your field" }).click();
  await expect(page).toHaveURL(/field=1/);
  await expect(page.getByText("Word matches can be wrong, so read the posting before you apply.").first()).toBeVisible();
  await expect(list.getByRole("button")).toHaveCount(3);
  await expect(list.getByRole("button", { name: /^Accountant/ })).toHaveCount(0);

  await list.getByRole("button", { name: /^Financial Analyst/ }).click();
  await expect(page.getByText(/EMIR and MiFIR in the text\./)).toBeVisible();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/niche-positions-desktop.png` });
});

test("fits a phone", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/jobs?sort=new&field=1");
  await expect(page.getByRole("list", { name: "Postings" }).getByRole("button", { name: /^Transaction Reporting Analyst/ })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/niche-positions-phone.png`, fullPage: true });
  await page.goto("/");
  await expect(page.getByText(/^In your field this week:/)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/niche-dashboard-phone.png`, fullPage: true });
});

test("sets how many are scored on their own each day in Settings → Scoring, and 0 switches it off", async ({ page }) => {
  await page.goto("/settings?section=scoring");
  const number = page.getByLabel("Score on their own, each day");
  await expect(number).toHaveValue("5");
  await expect(page.getByText(/Each one sends the posting and your profile to the scoring model above\./)).toBeVisible();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/niche-settings-desktop.png`, fullPage: true });
  await number.selectOption("0");
  await expect.poll(async () => (await sql<{ value: string }>(`SELECT value FROM "Setting" WHERE key = 'fieldScoresPerDay'`))[0]?.value).toBe("0");
  await page.reload();
  await expect(page.getByLabel("Score on their own, each day")).toHaveValue("0");
  await page.getByLabel("Score on their own, each day").selectOption("5");
  await expect.poll(async () => (await sql<{ value: string }>(`SELECT value FROM "Setting" WHERE key = 'fieldScoresPerDay'`))[0]?.value).toBe("5");
});

test("counts the week on the dashboard, and offers a posting in her field in Do today with Prepare", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText(/^In your field this week:/)).toContainText("In your field this week: 3 found by word match, 0 applied. Word matches can be wrong, so read the posting before you apply.");
  await expect(page.getByRole("link", { name: "Show all in your field" })).toHaveAttribute("href", "/jobs?sort=new&field=1");

  const today = page.getByRole("region", { name: "Do today" });
  const row = today.getByRole("listitem").filter({ hasText: "Transaction Reporting Analyst" });
  await expect(row).toContainText("In your field (word match): read the posting, then prepare it");
  await expect(today.getByRole("listitem").filter({ hasText: "Meldewesen Referent" })).toContainText("Check it is still open");
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/niche-dashboard-desktop.png`, fullPage: true });

  // Prepare writes the draft in the background, as Prepare it for me on Positions does: the posting becomes her draft.
  await row.getByRole("button", { name: "Prepare" }).click();
  await expect(page.getByRole("status").filter({ hasText: "The draft is ready for your review." })).toBeVisible({ timeout: 45_000 });
  await expect(today.getByRole("listitem").filter({ hasText: "In your field" }).filter({ hasText: "Northwind Clearing" })).toHaveCount(0);
  expect((await sql<{ status: string }>(`SELECT a.status FROM "Application" a JOIN "Posting" p ON p."applicationId" = a.id WHERE p.id = 'field-title'`))[0]?.status).toBe("DRAFT");
});
