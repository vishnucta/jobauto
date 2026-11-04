import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { FieldAdvice, FieldForAdvice } from "@/lib/ai/tasks/plan-apply-form";
import { launchWithFallback } from "@/lib/browser/launch";

import type { AnswerSet } from "./answers";
import { fillPage, onPage, type PageFillContext } from "./fill";
import { hasForm, scanControls } from "./form";

// The apply assistant's filling, in a real browser against the local test form
// (e2e/fixtures/apply-form.html): what src/lib/apply/run.ts does on every page,
// the first run's and each "Fill this page". Skipped on a computer without
// Chrome, Edge or Playwright's Chromium.

const dirs = vi.hoisted(() => ({ shots: "" }));
vi.mock("./files", async (importOriginal) => ({ ...(await importOriginal<typeof import("./files")>()), applyDir: () => dirs.shots }));

const browser: Browser | null = await launchWithFallback((options) => chromium.launch({ ...options, headless: true }), ["chrome", "msedge", "chromium"]).catch(() => null);

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
  salary: "55000",
  startDate: "sofort",
  noticePeriod: "keine",
  workPermit: "yes",
  sponsorship: "no",
  germanLevel: "A2",
  englishLevel: "C1",
  message: "Sehr geehrte Damen und Herren,\n\nich bewerbe mich als Financial Analyst.",
};

let dir = "";
let files: PageFillContext["files"];
beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "dossier-fill-"));
  dirs.shots = dir;
  files = { cv: path.join(dir, "Lebenslauf.pdf"), coverLetter: path.join(dir, "Anschreiben.pdf") };
  await writeFile(files.cv!, "%PDF-1.4\n%%EOF\n");
  await writeFile(files.coverLetter!, "%PDF-1.4\n%%EOF\n");
});
afterAll(async () => {
  await browser?.close();
  await rm(dir, { recursive: true, force: true });
});

const noAdvice = async (): Promise<FieldAdvice[] | null> => null;

/** The context a run gives it; `advise` is the model's side. */
function context(advise: (fields: FieldForAdvice[]) => Promise<FieldAdvice[] | null> = noAdvice) {
  const steps: string[] = [];
  const ctx: PageFillContext = {
    attemptId: "attempt-1",
    answers,
    files,
    advise,
    steps: { filling: "Filling in your details", attaching: "Attaching your PDFs" },
    step: async (name) => void steps.push(name),
    signal: new AbortController().signal,
  };
  return { ctx, steps };
}

/** The test form, opened on its form (the posting's own page has the apply button). */
async function openForm(): Promise<Page> {
  const page = await browser!.newPage({ locale: "de-DE" });
  await page.goto(pathToFileURL(path.resolve("e2e/fixtures/apply-form.html")).href);
  await page.click("#apply-entry");
  return page;
}

const value = (page: Page, selector: string) => page.locator(selector).inputValue();

describe.skipIf(!browser)("fillPage, in a real browser", { timeout: 60_000 }, () => {
  it("fills what the answers know, ticks consent and never the newsletter, attaches both PDFs, and leaves the rest to the user", async () => {
    const page = await openForm();
    const controls = await scanControls(page);
    expect(hasForm(controls)).toBe(true);
    const { ctx, steps } = context();
    const fill = await fillPage(page, controls, ctx);

    expect(steps).toEqual(["Filling in your details", "Attaching your PDFs"]);
    expect(await value(page, "#vorname")).toBe("Erika");
    expect(await value(page, "#nachname")).toBe("Mustermann");
    expect(await value(page, "#email")).toBe("erika.mustermann@example.com");
    expect(await value(page, "#tel")).toBe("+49 40 1234567");
    expect(await value(page, "#plz")).toBe("20095");
    expect(await value(page, "#ort")).toBe("Hamburg");
    expect(await value(page, "#land")).toBe("DE");
    expect(await value(page, "#frist")).toBe("keine");
    expect(await page.locator("#msg").inputValue()).toContain("ich bewerbe mich als Financial Analyst");
    expect(await page.locator("input[name=privacy]").isChecked()).toBe(true);
    expect(await page.locator("input[name=newsletter]").isChecked()).toBe(false);
    expect(await page.locator("#cv").evaluate((input: HTMLInputElement) => input.files?.[0]?.name)).toBe("Lebenslauf.pdf");
    expect(await page.locator("#letter").evaluate((input: HTMLInputElement) => input.files?.[0]?.name)).toBe("Anschreiben.pdf");

    // A personal choice, and a question the assistant doesn't know: the user's.
    expect(await value(page, "#anrede")).toBe("");
    expect(fill.unfilled.find((entry) => /Anrede/.test(entry.label))).toMatchObject({ required: true });
    expect(fill.unfilled.some((entry) => /aufmerksam/.test(entry.label))).toBe(true);
    expect(fill).toMatchObject({ captcha: false, cvAttached: true, screenshot: true });
    // Contact details are reported without their value.
    expect(fill.filled.find((entry) => /E-Mail/.test(entry.label))).toMatchObject({ value: "" });
    expect(fill.filled.find((entry) => /Vorname/.test(entry.label))?.byAi).toBeUndefined();
    await page.close();
  });

  it("leaves a field that already holds something as it was", async () => {
    const page = await openForm();
    await page.fill("#vorname", "Max");
    const { ctx } = context();
    const fill = await fillPage(page, await scanControls(page), ctx);
    expect(await value(page, "#vorname")).toBe("Max");
    expect(await value(page, "#nachname")).toBe("Mustermann");
    expect(fill.filled.some((entry) => /Vorname/.test(entry.label))).toBe(false);
    await page.close();
  });

  it("asks the model only about the fields the matcher left, and types what it writes, marked as the AI's", async () => {
    const page = await openForm();
    const asked: FieldForAdvice[][] = [];
    const { ctx } = context(async (fields) => {
      asked.push(fields);
      return fields.map((field) =>
        /aufmerksam/.test(field.label)
          ? { ref: field.ref, key: null, option: null, text: "Über Ihre Website.", leave: null }
          : { ref: field.ref, key: null, option: null, text: null, leave: "a personal choice" },
      );
    });
    const fill = await fillPage(page, await scanControls(page), ctx);

    expect(asked).toHaveLength(1);
    const labels = asked[0].map((field) => field.label);
    expect(labels.some((label) => /aufmerksam/.test(label))).toBe(true);
    // What the matcher filled was never put to the model.
    expect(labels.some((label) => /Vorname|E-Mail|Kündigungsfrist/.test(label))).toBe(false);
    expect(await value(page, "#src")).toBe("Über Ihre Website.");
    expect(fill.filled.find((entry) => /aufmerksam/.test(entry.label))).toMatchObject({ what: "Written by the AI", byAi: true });
    await page.close();
  });

  it("goes on without the model when it has no advice, and fills a second page the same way", async () => {
    const page = await openForm();
    const first = await fillPage(page, await scanControls(page), context().ctx);

    // The next step of a form, in the same window: other fields, other answers.
    await page.setContent(
      `<form><label for="v">Vorname</label><input id="v" /><label for="n">Nachname</label><input id="n" /><label for="e">E-Mail-Adresse</label><input id="e" type="email" /><label for="f">Kündigungsfrist</label><input id="f" /><label for="p">Telefon</label><input id="p" type="tel" /></form>`,
    );
    const second = await fillPage(page, await scanControls(page), context().ctx);
    expect(await value(page, "#v")).toBe("Erika");
    expect(await value(page, "#n")).toBe("Mustermann");
    expect(await value(page, "#f")).toBe("keine");
    expect(second.filled.length).toBeGreaterThanOrEqual(5);

    // As the run records them: each page's entries carry its number.
    const both = [...onPage(first.filled, 1), ...onPage(second.filled, 2)];
    expect(new Set(both.map((entry) => entry.page))).toEqual(new Set([1, 2]));
    await page.close();
  });

  it("doesn't wait for a frame that never answers", async () => {
    const page = await openForm();
    // A frame still loading, as an ad or a widget can be: the form around it is read without it.
    await page.evaluate(() => {
      const frame = document.createElement("iframe");
      frame.src = "about:blank#never-answers";
      document.body.append(frame);
    });
    const started = Date.now();
    const controls = await scanControls(page);
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(hasForm(controls)).toBe(true);
    await page.close();
  });

  it("reports a CAPTCHA on the page", async () => {
    const page = await openForm();
    await page.evaluate(() => document.body.insertAdjacentHTML("beforeend", '<div class="g-recaptcha" data-sitekey="x"></div>'));
    const fill = await fillPage(page, await scanControls(page), context().ctx);
    expect(fill.captcha).toBe(true);
    await page.close();
  });

  it("leaves the file fields to the user when there is no PDF to attach, and says nothing is missing", async () => {
    const page = await openForm();
    const { ctx } = context();
    const fill = await fillPage(page, await scanControls(page), { ...ctx, files: { cv: null, coverLetter: null } });
    expect(fill.cvAttached).toBe(true);
    expect(fill.captcha).toBe(false);
    expect(fill.unfilled.some((entry) => /Lebenslauf/.test(entry.label))).toBe(true);
    await page.close();
  });
});
