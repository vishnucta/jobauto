import { expect, test } from "@playwright/test";

import { resetData, sql } from "./support";

// Apply at the source (jobauto fork): a draft whose link is a copy of the ad
// on a site that collects job ads gets the way to the employer's own posting
// instead of the apply assistant, and the link she pastes is used from then on.
const COPY = "https://de.jooble.org/jdp/42";
const OWN = "https://ledgerly.jobs.personio.de/job/42";
/** Where a spec may leave screenshots to look at, when E2E_SHOTS names a folder. */
const SHOTS = process.env.E2E_SHOTS;

let id = "";
test.beforeAll(async () => {
  await resetData();
  [{ id }] = await sql<{ id: string }>(`SELECT id FROM "Application" WHERE company = 'Ledgerly' LIMIT 1`);
});
test.beforeEach(async () => {
  await sql(`UPDATE "Application" SET "postingUrl" = $2 WHERE id = $1`, [id, COPY]);
});

test("says the link is a copy, offers the way to the employer's posting, and sends through the link she pastes", async ({ page }) => {
  await page.goto(`/applications/${id}`);
  const guide = page.getByRole("region", { name: "How to send this application" });
  await expect(guide).toContainText("This link is a copy of the ad on Jooble (de.jooble.org)");
  await expect(guide).not.toContainText("its own page");

  await page.getByRole("button", { name: "Find the employer's posting" }).click();
  const panel = page.locator("section", { has: page.getByRole("heading", { name: "Find the employer's posting" }) });
  await expect(panel).toContainText("Apply where Ledgerly's recruiter reads applications");
  await expect(panel.getByRole("link", { name: /Search for it/ })).toHaveAttribute("href", /^https:\/\/www\.google\.com\/search\?q=Ledgerly/);
  await expect(panel.getByRole("link", { name: /Open the copy on Jooble anyway/ })).toHaveAttribute("href", COPY);
  await expect(page.getByRole("button", { name: /Open and fill it in/ })).toHaveCount(0);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/apply-copy-desktop.png`, fullPage: true });

  await panel.getByLabel("The employer's link").fill(OWN);
  await panel.getByRole("button", { name: "Use this link" }).click();
  await expect(page.getByRole("status")).toContainText("Link saved. It goes to the employer's own page now (ledgerly.jobs.personio.de)");
  await expect(page.getByRole("button", { name: "Open and fill it in" })).toBeVisible();
  await expect(guide).toContainText("This employer takes applications on its own page (Personio, ledgerly.jobs.personio.de).");
  expect((await sql<{ postingUrl: string }>(`SELECT "postingUrl" FROM "Application" WHERE id = $1`, [id]))[0].postingUrl).toBe(OWN);
});

test("fits a phone", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/applications/${id}?tab=apply`);
  await expect(page.getByRole("heading", { name: "Find the employer's posting" })).toBeVisible();
  await expect(page.getByLabel("The employer's link")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/apply-copy-phone.png`, fullPage: true });
});
