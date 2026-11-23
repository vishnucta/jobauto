import { expect, test } from "@playwright/test";

import { resetData, sql } from "./support";

// Keep every apply option (jobauto fork): a posting keeps every place its
// portal listed to apply at, shows the others in its details, and the "Find
// the employer's posting" panel offers them, one click each. Made-up
// employers and links only.
/** Where a spec may leave screenshots to look at, when E2E_SHOTS names a folder. */
const SHOTS = process.env.E2E_SHOTS;

const COPY = "https://de.jooble.org/jdp/77";
const OWN = "https://ledgerly.jobs.personio.de/job/77";
const OPTIONS = [
  { name: "Jooble", url: COPY },
  { name: "LinkedIn", url: "https://www.linkedin.com/jobs/view/77" },
  { name: "Ledgerly Careers", url: OWN },
];

let applicationId = "";
test.beforeAll(async () => {
  await resetData();
  [{ id: applicationId }] = await sql<{ id: string }>(`SELECT id FROM "Application" WHERE company = 'Ledgerly' LIMIT 1`);
  // A posting kept before, with the copy's link, found again since with every place it's listed at; her draft was made from it.
  await sql(`UPDATE "Application" SET "postingUrl" = $2 WHERE id = $1`, [applicationId, COPY]);
  await sql(
    `INSERT INTO "Posting" (id, source, "externalId", title, company, place, url, "applyOptions", description, complete, "applicationId", "updatedAt")
     VALUES ('kept-77', 'JSEARCH', 'kept-77', 'Senior Product Designer, Payments', 'Ledgerly', 'Hamburg', $1, $2::jsonb, 'Our team works in English.', true, $3, now())`,
    [COPY, JSON.stringify(OPTIONS), applicationId],
  );
  // A posting found since this change: its link is the employer's own, the others listed.
  await sql(
    `INSERT INTO "Posting" (id, source, "externalId", title, company, place, url, "applyOptions", description, complete, "updatedAt")
     VALUES ('new-78', 'JSEARCH', 'new-78', 'Transaction Reporting Analyst', 'Northwind Clearing', 'Hamburg', $1, $2::jsonb, 'Our team works in English.', true, now())`,
    [
      "https://northwind.wd3.myworkdayjobs.com/External/job/78",
      JSON.stringify([
        { name: "Trabajo.org", url: "https://www.trabajo.org/job-78" },
        { name: "", url: "https://www.stepstone.de/stellenangebote--78.html" },
        { name: "Northwind Clearing", url: "https://northwind.wd3.myworkdayjobs.com/External/job/78" },
      ]),
    ],
  );
});

test("shows the other places a posting is listed at in its details, the employer's own link as Open posting", async ({ page }) => {
  await page.goto("/jobs?sort=new");
  await page.getByRole("list", { name: "Postings" }).getByRole("button", { name: /^Transaction Reporting Analyst/ }).click();
  await expect(page.getByRole("link", { name: /Open posting/ })).toHaveAttribute("href", "https://northwind.wd3.myworkdayjobs.com/External/job/78");
  const also = page.locator("dd", { has: page.getByRole("link", { name: /stepstone\.de/ }) });
  await expect(also.getByRole("link")).toHaveText(["stepstone.de (opens in a new tab)", "Trabajo.org (a copy of the ad) (opens in a new tab)"]);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/options-positions-desktop.png` });
});

test("offers the employer's own listing in the Find the employer's posting panel, and uses it in one click", async ({ page }) => {
  await page.goto(`/applications/${applicationId}?tab=apply`);
  const list = page.getByRole("list", { name: "Also listed at" });
  await expect(list.getByRole("listitem")).toHaveCount(2);
  await expect(list.getByRole("listitem").first()).toContainText("Ledgerly Careers · ledgerly.jobs.personio.de");
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/options-apply-desktop.png`, fullPage: true });
  await list.getByRole("button", { name: "Use this link: Ledgerly Careers" }).click();
  await expect(page.getByRole("status")).toContainText("Link saved. It goes to the employer's own page now (ledgerly.jobs.personio.de)");
  await expect(page.getByRole("region", { name: "How to send this application" })).toContainText("This employer takes applications on its own page (Personio, ledgerly.jobs.personio.de).");
  expect((await sql<{ postingUrl: string }>(`SELECT "postingUrl" FROM "Application" WHERE id = $1`, [applicationId]))[0].postingUrl).toBe(OWN);
  // The posting Positions keeps is left as it was found.
  expect((await sql<{ url: string }>(`SELECT url FROM "Posting" WHERE id = 'kept-77'`))[0].url).toBe(COPY);
});

test("fits a phone", async ({ page }) => {
  await sql(`UPDATE "Application" SET "postingUrl" = $2 WHERE id = $1`, [applicationId, COPY]);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/applications/${applicationId}?tab=apply`);
  await expect(page.getByRole("list", { name: "Also listed at" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/options-apply-phone.png`, fullPage: true });
});
