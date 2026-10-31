import type { FieldAdvice, FieldForAdvice } from "@/lib/ai/tasks/plan-apply-form";

import type { AnswerSet } from "./answers";
import { chooseOption, labelOf, valueFor, type FillAction, type FillPlan, type FormControl } from "./fields";

// Folding the model's advice (plan-apply-form) into the matcher's plan
// (Phase A): the model only ever adds to what's left, and only in ways the
// page's own controls allow. A ref it didn't get, an option that isn't
// there, a text for an email field: all ignored.

const MAX_TEXT = 2_000;
const MAX_REASON = 160;
const TEXT_TYPES = new Set(["", "text", "textarea", "search"]);

/** The fields the matcher left, as the model gets them: no values, no ids. */
export function fieldsForAdvice(plan: FillPlan, controls: readonly FormControl[]): FieldForAdvice[] {
  const byRef = new Map(controls.map((control) => [control.ref, control]));
  return plan.unfilled.flatMap((entry) => {
    const control = byRef.get(entry.ref);
    if (!control || control.type === "password" || control.type === "file") return [];
    // A radio group is one question: its options are the group's radios.
    const options =
      control.type === "radio"
        ? controls.filter((radio) => radio.type === "radio" && (radio.name || radio.group || radio.ref) === (control.name || control.group || control.ref)).map((radio) => ({ value: radio.ref, text: radio.label || radio.aria || radio.value }))
        : control.options.slice(0, 60);
    return [{ ref: control.ref, label: entry.label, type: control.type, group: control.group, required: control.required, options }];
  });
}

/** Actions written by the model (free text), for the report: the user should read these before sending. */
export type AdvisedPlan = FillPlan & { byAi: Set<string> };

/** The plan with the model's advice folded in, where the page allows it. */
export function applyAdvice(plan: FillPlan, advice: readonly FieldAdvice[], controls: readonly FormControl[], answers: AnswerSet): AdvisedPlan {
  const byRef = new Map(controls.map((control) => [control.ref, control]));
  const unfilledByRef = new Map(plan.unfilled.map((entry) => [entry.ref, entry]));
  const actions: FillAction[] = [...plan.actions];
  const byAi = new Set<string>();
  const resolved = new Set<string>();
  const reasons = new Map<string, string>();

  for (const item of advice) {
    const control = byRef.get(item.ref);
    const entry = unfilledByRef.get(item.ref);
    if (!control || !entry || resolved.has(item.ref)) continue;
    const label = labelOf(control);
    const radios = control.type === "radio" ? controls.filter((radio) => radio.type === "radio" && (radio.name || radio.group || radio.ref) === (control.name || control.group || control.ref)) : [];

    if (item.key) {
      const answer = answers[item.key];
      if (!answer) continue;
      if (control.tag === "select") {
        const option = chooseOption(item.key, answer, control.options);
        if (!option) continue;
        actions.push({ kind: "select", ref: control.ref, label, key: item.key, value: option.value, text: option.text });
      } else if (control.type === "radio") {
        const option = chooseOption(item.key, answer, radios.map((radio) => ({ value: radio.ref, text: radio.label || radio.aria || radio.value })));
        if (!option) continue;
        actions.push({ kind: "check", ref: option.value, label: `${entry.label}: ${option.text}`, key: item.key });
      } else if (control.type === "checkbox") {
        continue;
      } else {
        const value = valueFor(item.key, answer, control.type);
        if (value === null) continue;
        actions.push({ kind: "type", ref: control.ref, label, key: item.key, value });
      }
      resolved.add(item.ref);
    } else if (item.option) {
      if (control.tag === "select") {
        const option = control.options.find((candidate) => candidate.value === item.option || candidate.text === item.option);
        if (!option) continue;
        actions.push({ kind: "select", ref: control.ref, label, key: "message", value: option.value, text: option.text });
        byAi.add(control.ref);
      } else if (control.type === "radio") {
        const radio = radios.find((candidate) => candidate.ref === item.option || candidate.label === item.option || candidate.value === item.option);
        if (!radio) continue;
        actions.push({ kind: "check", ref: radio.ref, label: `${entry.label}: ${radio.label || radio.value}`, key: "message" });
        byAi.add(radio.ref);
      } else continue;
      resolved.add(item.ref);
    } else if (item.text) {
      if (control.tag === "select" || !TEXT_TYPES.has(control.type)) continue;
      const text = item.text.trim().slice(0, MAX_TEXT);
      if (!text) continue;
      actions.push({ kind: "type", ref: control.ref, label, key: "message", value: text });
      byAi.add(control.ref);
      resolved.add(item.ref);
    } else if (item.leave) {
      reasons.set(item.ref, item.leave.trim().slice(0, MAX_REASON));
    }
  }

  const unfilled = plan.unfilled
    .filter((entry) => !resolved.has(entry.ref))
    .map((entry) => (reasons.has(entry.ref) ? { ...entry, reason: reasons.get(entry.ref)! } : entry));
  return { actions, unfilled, kept: plan.kept, byAi };
}
