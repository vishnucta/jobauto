import type { Frame, Locator, Page } from "playwright-core";

import { detectAts } from "./ats";
import { COOKIE_ACCEPT_SELECTORS, COOKIE_ACCEPT_TEXTS, entryButtons, SUBMIT_TEXTS } from "./confirmation";
import type { FillAction, FileKind, FormControl } from "./fields";

// Working an employer's page in the browser (Phase A): reading its form
// into plain data for fields.ts to plan, carrying the plan out, and the
// clicks around it (cookie banners, "Jetzt bewerben", Send). Nothing here
// decides what to type: that's the plan's.

/** The attribute the scan leaves on every control, so the plan can find it again. */
export const REF_ATTRIBUTE = "data-bewerbung-ref";

const ACTION_TIMEOUT_MS = 8_000;

type ScanArgs = { prefix: string; attribute: string };

/**
 * Runs in the page, as plain JavaScript text: a function serialised from
 * this module would carry the transpiler's helpers (`__name`), which the
 * page doesn't have. Marks every usable control with a ref and describes
 * it: its own label (from <label>, aria, the text before it), the question
 * it belongs to (a fieldset's legend), its options. Hidden fields, buttons
 * and invisible controls are left out, except file inputs, which sites
 * hide behind styled buttons.
 */
const SCAN_SCRIPT = String.raw`(function (args) {
  var prefix = args.prefix, attribute = args.attribute;
  var text = function (node) { return ((node && node.textContent) || "").replace(/\s+/g, " ").trim(); };
  var visible = function (element) {
    var style = getComputedStyle(element);
    if (style.visibility === "hidden" || style.display === "none") return false;
    var rect = element.getBoundingClientRect();
    return rect.width > 0 || rect.height > 0;
  };
  var hiddenAncestor = function (element) {
    for (var node = element.parentElement; node && node !== document.body; node = node.parentElement) {
      var style = getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden") return true;
    }
    return false;
  };
  var labelFor = function (element) {
    if (element.labels && element.labels.length > 0) return Array.prototype.map.call(element.labels, text).filter(Boolean).join(" ");
    var labelledBy = element.getAttribute("aria-labelledby");
    if (labelledBy) {
      var parts = labelledBy.split(/\s+/).map(function (id) { return text(document.getElementById(id)); }).filter(Boolean);
      if (parts.length > 0) return parts.join(" ");
    }
    var wrapping = element.closest("label");
    if (wrapping) return text(wrapping);
    var node = element.previousElementSibling;
    for (var hops = 0; node && hops < 3; hops++, node = node.previousElementSibling) {
      if (/^(label|span|div|p|legend|strong|b|h[1-6])$/i.test(node.tagName) && text(node)) return text(node).slice(0, 200);
    }
    var parent = element.parentElement;
    if (parent) {
      var around = text(parent).replace(text(element), "").trim();
      if (around && around.length < 200) return around;
    }
    return "";
  };
  var groupFor = function (element) {
    var fieldset = element.closest("fieldset");
    var legend = fieldset ? fieldset.querySelector("legend") : null;
    if (legend) return text(legend);
    var group = element.closest("[role=radiogroup],[role=group]");
    if (group) {
      var labelledBy = group.getAttribute("aria-labelledby");
      var byId = labelledBy ? text(document.getElementById(labelledBy.split(/\s+/)[0])) : "";
      return byId || group.getAttribute("aria-label") || "";
    }
    var container = element.closest("div, li, section, td");
    var heading = container && container.parentElement ? container.parentElement.querySelector("legend, label, h1, h2, h3, h4, h5, h6, p, span") : null;
    if (heading && heading !== element && !heading.contains(element)) return text(heading).slice(0, 200);
    return "";
  };
  var controls = [];
  var index = 0;
  var elements = Array.prototype.slice.call(document.querySelectorAll("input, select, textarea"));
  for (var i = 0; i < elements.length; i++) {
    var element = elements[i];
    var tag = element.tagName.toLowerCase();
    var type = tag === "input" ? (element.getAttribute("type") || "text").toLowerCase() : tag;
    if (["hidden", "submit", "button", "reset", "image"].indexOf(type) >= 0) continue;
    if (element.disabled) continue;
    if (type === "file" ? hiddenAncestor(element) : !visible(element)) continue;
    var ref = prefix + "-" + index++;
    element.setAttribute(attribute, ref);
    var choice = type === "checkbox" || type === "radio";
    controls.push({
      ref: ref,
      tag: tag,
      type: type,
      name: element.getAttribute("name") || "",
      id: element.id || "",
      label: labelFor(element).slice(0, 300),
      placeholder: element.getAttribute("placeholder") || "",
      autocomplete: element.getAttribute("autocomplete") || "",
      aria: element.getAttribute("aria-label") || "",
      group: choice || tag === "select" ? groupFor(element).slice(0, 300) : "",
      required: Boolean(element.required) || element.getAttribute("aria-required") === "true",
      value: tag === "select" ? element.value : choice || type === "file" ? "" : (element.value || ""),
      checked: choice ? Boolean(element.checked) : false,
      options: tag === "select" ? Array.prototype.slice.call(element.options, 0, 200).map(function (option) { return { value: option.value, text: text(option) }; }) : [],
      multiple: Boolean(element.multiple),
      accept: element.getAttribute("accept") || ""
    });
  }
  return controls;
})`;

/** The page's form controls, in its frames too (widgets often sit in an iframe). */
export async function scanControls(page: Page): Promise<FormControl[]> {
  const controls: FormControl[] = [];
  for (const [index, frame] of page.frames().entries()) {
    try {
      const args: ScanArgs = { prefix: `f${index}`, attribute: REF_ATTRIBUTE };
      controls.push(...((await frame.evaluate(`${SCAN_SCRIPT}(${JSON.stringify(args)})`)) as FormControl[]));
    } catch {
      // A frame that navigated away, or one that can't be scripted: nothing to fill there.
    }
  }
  return controls;
}

/** The frame a ref lives in, from its prefix. */
function frameOf(page: Page, ref: string): Frame {
  const index = Number(/^f(\d+)-/.exec(ref)?.[1] ?? 0);
  return page.frames()[index] ?? page.mainFrame();
}

function locate(page: Page, ref: string): Locator {
  return frameOf(page, ref).locator(`[${REF_ATTRIBUTE}="${ref}"]`);
}

export type FillReport = { done: FillAction[]; failed: { action: FillAction; problem: string }[] };

/** Ticks a box, by the normal click or, for a styled box whose input is hidden, by hand. */
async function tick(locator: Locator): Promise<void> {
  try {
    await locator.check({ timeout: ACTION_TIMEOUT_MS });
  } catch {
    await locator.evaluate((element) => {
      const input = element as HTMLInputElement;
      if (!input.checked) input.click();
      if (!input.checked) {
        input.checked = true;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
      }
    });
  }
}

/** Carries a plan out, one action at a time; a field that won't take its value is reported, not fatal. */
export async function executeFill(page: Page, actions: readonly FillAction[], files: Record<FileKind, string | null>): Promise<FillReport> {
  const report: FillReport = { done: [], failed: [] };
  for (const action of actions) {
    const locator = locate(page, action.ref).first();
    try {
      switch (action.kind) {
        case "type":
          await locator.fill(action.value, { timeout: ACTION_TIMEOUT_MS });
          break;
        case "select":
          await locator.selectOption({ value: action.value }, { timeout: ACTION_TIMEOUT_MS });
          break;
        case "check":
          await tick(locator);
          break;
        case "upload": {
          const paths = action.files.map((kind) => files[kind]).filter((path): path is string => Boolean(path));
          if (paths.length === 0) throw new Error("no file to attach");
          await locator.setInputFiles(paths, { timeout: ACTION_TIMEOUT_MS });
          break;
        }
      }
      report.done.push(action);
    } catch (error) {
      report.failed.push({ action, problem: error instanceof Error ? error.message.split("\n")[0] : String(error) });
    }
  }
  return report;
}

/** The first visible button or link whose name matches one of the patterns, in their order, and none of `except`. */
async function findButton(page: Page, patterns: readonly RegExp[], except: readonly RegExp[] = []): Promise<Locator | null> {
  for (const pattern of patterns) {
    for (const frame of page.frames()) {
      for (const role of ["button", "link"] as const) {
        const candidates = frame.getByRole(role, { name: pattern });
        const count = await candidates.count().catch(() => 0);
        for (let index = 0; index < Math.min(count, 5); index++) {
          const candidate = candidates.nth(index);
          if (!(await candidate.isVisible().catch(() => false))) continue;
          if (except.length > 0 && (await namedLike(frame, role, candidate, except))) continue;
          return candidate;
        }
      }
    }
  }
  return null;
}

/** Whether a button's name also matches one of the patterns; one that can't be read counts as matching. */
async function namedLike(frame: Frame, role: "button" | "link", candidate: Locator, patterns: readonly RegExp[]): Promise<boolean> {
  const named = patterns.map((pattern) => frame.getByRole(role, { name: pattern })).reduce((either, other) => either.or(other));
  return (await candidate.and(named).count().catch(() => 1)) > 0;
}

/** Clicks a cookie banner away, if one is up; true when something was clicked. */
export async function dismissCookieBanner(page: Page): Promise<boolean> {
  for (const selector of COOKIE_ACCEPT_SELECTORS) {
    const button = page.locator(selector).first();
    if (await button.isVisible().catch(() => false)) {
      await button.click({ timeout: ACTION_TIMEOUT_MS }).catch(() => {});
      return true;
    }
  }
  const button = await findButton(page, COOKIE_ACCEPT_TEXTS);
  if (!button) return false;
  await button.click({ timeout: ACTION_TIMEOUT_MS }).catch(() => {});
  return true;
}

/** Whether the page holds a form worth filling: a file input, or a few fields. */
export function hasForm(controls: readonly FormControl[]): boolean {
  return controls.some((control) => control.type === "file") || controls.filter((control) => control.type !== "checkbox" && control.type !== "radio").length >= 3;
}

/**
 * Clicks "Jetzt bewerben" (or the like) and returns the page the form is
 * on: the same one, or the tab it opened. Null when there's no such button.
 * `pastPosting` says an entry button was clicked already: from there on, a
 * button named like Send is left alone (see entryButtons).
 */
export async function clickApplyEntry(page: Page, { pastPosting = false }: { pastPosting?: boolean } = {}): Promise<Page | null> {
  const { texts, except } = entryButtons({ board: detectAts(page.url()).board, pastPosting });
  const button = await findButton(page, texts, except);
  if (!button) return null;
  const popup = page.context().waitForEvent("page", { timeout: 4_000 }).catch(() => null);
  await button.click({ timeout: ACTION_TIMEOUT_MS });
  const opened = await popup;
  const target = opened ?? page;
  await target.waitForLoadState("domcontentloaded", { timeout: 20_000 }).catch(() => {});
  await target.waitForTimeout(1_500);
  return target;
}

/** Presses the form's Send button; false when there isn't one to be found. */
export async function clickSubmit(page: Page): Promise<boolean> {
  const button = await findButton(page, SUBMIT_TEXTS);
  if (!button) return false;
  await button.click({ timeout: ACTION_TIMEOUT_MS });
  return true;
}

/** The page's visible text, frames included, for reading confirmations. */
export async function pageText(page: Page): Promise<string> {
  const parts: string[] = [];
  for (const frame of page.frames()) {
    parts.push(await frame.evaluate(() => document.body?.innerText ?? "").catch(() => ""));
  }
  return parts.join("\n");
}

/** Whether the controls the scan marked are still on the page. */
export async function formStillThere(page: Page): Promise<boolean> {
  for (const frame of page.frames()) {
    const count = await frame.locator(`[${REF_ATTRIBUTE}]`).count().catch(() => 0);
    if (count > 0) return true;
  }
  return false;
}

/** The addresses of the page's frames, for spotting CAPTCHA widgets. */
export function frameUrls(page: Page): string[] {
  return page.frames().map((frame) => frame.url());
}
