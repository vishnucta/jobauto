// A dry run of the apply assistant's engine, without the app or the
// database: opens the local test form (or a URL you pass), clicks the
// cookie banner and "Jetzt bewerben" away, reads the form, plans the fill
// from sample answers, fills it, and prints what it did and what it left.
// It never presses Send on a real page; `--submit` presses it on the local
// form only, to check the confirmation is read. Run with:
//   yarn tsx scripts/try-apply.ts                       # local form, headless
//   yarn tsx scripts/try-apply.ts --headed              # watch it
//   yarn tsx scripts/try-apply.ts https://... --headed  # a real page, no Send
import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { chromium } from "playwright-core";

import { type AnswerSet } from "../src/lib/apply/answers";
import { looksLikeCaptcha, looksSubmitted } from "../src/lib/apply/confirmation";
import { planFill } from "../src/lib/apply/fields";
import { clickApplyEntry, clickSubmit, dismissCookieBanner, executeFill, formStillThere, frameUrls, hasForm, pageText, scanControls } from "../src/lib/apply/form";
import { launchWithFallback } from "../src/lib/browser/launch";

const args = process.argv.slice(2);
const headed = args.includes("--headed");
const submit = args.includes("--submit");
const target = args.find((arg) => /^https?:\/\//.test(arg)) ?? pathToFileURL(path.resolve("e2e/fixtures/apply-form.html")).href;
const local = target.startsWith("file:");

/** Sample answers, not a real person. */
const answers: AnswerSet = {
  firstName: "Erika",
  lastName: "Mustermann",
  fullName: "Erika Mustermann",
  email: "erika.mustermann@example.com",
  phone: "+49 40 1234567",
  street: "Musterstraße 12",
  postalCode: "20095",
  city: "Hamburg",
  country: "Germany",
  linkedin: "https://www.linkedin.com/in/erika-mustermann",
  website: "",
  dob: "1985-01-15",
  salary: "55.000 € brutto/Jahr",
  startDate: "sofort",
  noticePeriod: "keine",
  workPermit: "yes",
  sponsorship: "no",
  germanLevel: "A2",
  englishLevel: "C1",
  message: "Sehr geehrte Damen und Herren,\n\nich bewerbe mich als Financial Analyst.",
};

/** A tiny but valid PDF, so uploads have something to attach. */
function samplePdf(dir: string, name: string): string {
  const body = `%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]>>endobj\nxref\n0 4\n0000000000 65535 f \n0000000009 00000 n \n0000000052 00000 n \n0000000101 00000 n \ntrailer<</Size 4/Root 1 0 R>>\nstartxref\n160\n%%EOF\n`;
  const file = path.join(dir, name);
  writeFileSync(file, body);
  return file;
}

async function main() {
  const dir = path.join(os.tmpdir(), "bewerbung-try-apply");
  mkdirSync(dir, { recursive: true });
  const files = { cv: samplePdf(dir, "Lebenslauf.pdf"), coverLetter: samplePdf(dir, "Anschreiben.pdf") };

  const browser = await launchWithFallback((options) => chromium.launch({ ...options, headless: !headed }), ["chrome", "msedge", "chromium"]);
  const context = await browser.newContext({ locale: "de-DE" });
  let page = await context.newPage();
  console.log(`Opening ${target}`);
  await page.goto(target, { waitUntil: "domcontentloaded", timeout: 45_000 });
  await page.waitForTimeout(1_000);
  if (await dismissCookieBanner(page)) console.log("Cookie banner: clicked away.");

  let controls = await scanControls(page);
  for (let attempt = 0; attempt < 2 && !hasForm(controls); attempt++) {
    const next = await clickApplyEntry(page);
    if (!next) break;
    console.log(`Clicked the apply button${next === page ? "" : " (opened a new tab)"}.`);
    page = next;
    await dismissCookieBanner(page);
    controls = await scanControls(page);
  }
  console.log(`Form: ${controls.length} controls${hasForm(controls) ? "" : " (doesn't look like an application form)"}.`);

  const plan = planFill(controls, answers, { cv: true, coverLetter: true });
  const report = await executeFill(page, plan.actions, files);
  for (const action of report.done) console.log(`  filled  ${action.label} ← ${action.kind === "type" ? action.value.split("\n")[0] : action.kind === "select" ? action.text : action.kind === "upload" ? action.files.join(", ") : "✓"}`);
  for (const { action, problem } of report.failed) console.log(`  FAILED  ${action.label}: ${problem}`);
  for (const entry of plan.unfilled) console.log(`  left    ${entry.label}${entry.required ? " *" : ""} (${entry.reason})`);
  for (const entry of plan.kept) console.log(`  kept    ${entry.label}`);
  const captcha = looksLikeCaptcha({ html: await page.content(), frameUrls: frameUrls(page) });
  console.log(`CAPTCHA on the page: ${captcha ? "yes" : "no"}`);

  if (submit && local) {
    // What's left to the user, the user would do: pick the first real option of each required select, so Send goes through.
    for (const entry of plan.unfilled) {
      const control = controls.find((candidate) => candidate.ref === entry.ref);
      if (control?.tag === "select" && control.required) await page.locator(`[data-bewerbung-ref="${entry.ref}"]`).selectOption({ index: 1 });
    }
    console.log(await clickSubmit(page) ? "Pressed Send." : "No Send button found.");
    await page.waitForTimeout(500);
    const gone = !(await formStillThere(page));
    const sent = looksSubmitted({ text: await pageText(page), url: page.url(), formGone: gone });
    console.log(`Confirmation read: ${sent ? "yes" : "no"} (form gone: ${gone})`);
    console.log("The form received:", JSON.stringify(await page.evaluate(() => (window as unknown as { __submitted?: unknown }).__submitted), null, 2));
  } else if (headed) {
    console.log("Leaving the window open for 60 seconds so you can look.");
    await page.waitForTimeout(60_000);
  }
  await browser.close();
  console.log(`Done: ${report.done.length} filled, ${report.failed.length} failed, ${plan.unfilled.length} left to the user.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
