import { describe, expect, it } from "vitest";

import { applyAdvice, fieldsForAdvice } from "./advice";
import { buildAnswerSet, DEFAULT_APPLY_ANSWERS } from "./answers";
import { planFill, REASONS, type FormControl } from "./fields";

const control = (over: Partial<FormControl> & { ref: string }): FormControl => ({
  tag: "input",
  type: "text",
  name: "",
  id: "",
  label: "",
  placeholder: "",
  autocomplete: "",
  aria: "",
  group: "",
  required: false,
  value: "",
  checked: false,
  options: [],
  multiple: false,
  accept: "",
  ...over,
});

const answers = buildAnswerSet({
  basics: { name: "Erika Mustermann", email: "e@example.com", phone: "", address: "", city: "Hamburg", country: "Germany", linkedin: "", website: "", dob: "" },
  answers: { ...DEFAULT_APPLY_ANSWERS, salary: "55.000 €", startDate: "sofort" },
  letterParagraphs: ["Ich bewerbe mich."],
});

const controls: FormControl[] = [
  control({ ref: "f0-0", label: "Vorname" }),
  control({ ref: "f0-1", tag: "select", type: "select", label: "Anrede", required: true, options: [{ value: "", text: "Bitte wählen" }, { value: "f", text: "Frau" }, { value: "m", text: "Herr" }] }),
  control({ ref: "f0-2", tag: "textarea", type: "textarea", label: "Warum möchten Sie bei uns arbeiten?" }),
  control({ ref: "f0-3", label: "Ihre Vorstellung (brutto, jährlich)" }),
  control({ ref: "f0-4", type: "radio", name: "remote", group: "Möchten Sie remote arbeiten?", label: "Ja" }),
  control({ ref: "f0-5", type: "radio", name: "remote", group: "Möchten Sie remote arbeiten?", label: "Nein" }),
  control({ ref: "f0-6", type: "email", label: "Firmen-Kontakt" }),
  control({ ref: "f0-7", type: "password", label: "Passwort" }),
];

describe("the model's advice on a form (Phase A)", () => {
  const plan = planFill(controls, answers, { cv: false, coverLetter: false });

  it("asks only about what the matcher left, and never about passwords", () => {
    const fields = fieldsForAdvice(plan, controls);
    expect(fields.map((field) => field.ref)).toEqual(["f0-1", "f0-4", "f0-2", "f0-3"]);
    expect(fields.find((field) => field.ref === "f0-4")).toMatchObject({
      type: "radio",
      group: "Möchten Sie remote arbeiten?",
      options: [
        { value: "f0-4", text: "Ja" },
        { value: "f0-5", text: "Nein" },
      ],
    });
    expect(JSON.stringify(fields)).not.toContain("e@example.com");
  });

  it("folds a key, an option, a text and a reason into the plan", () => {
    const advised = applyAdvice(
      plan,
      [
        { ref: "f0-3", key: "salary", option: null, text: null, leave: null },
        { ref: "f0-2", key: null, option: null, text: "Ich arbeite gern mit Zahlen. Die Stelle passt zu meiner Erfahrung.", leave: null },
        { ref: "f0-4", key: null, option: "f0-5", text: null, leave: null },
        { ref: "f0-1", key: null, option: null, text: null, leave: "a personal choice" },
      ],
      controls,
      answers,
    );
    expect(advised.actions.slice(plan.actions.length)).toEqual([
      { kind: "type", ref: "f0-3", label: "Ihre Vorstellung (brutto, jährlich)", key: "salary", value: "55.000 €" },
      { kind: "type", ref: "f0-2", label: "Warum möchten Sie bei uns arbeiten?", key: "message", value: "Ich arbeite gern mit Zahlen. Die Stelle passt zu meiner Erfahrung." },
      { kind: "check", ref: "f0-5", label: "Möchten Sie remote arbeiten?: Nein", key: "message" },
    ]);
    expect([...advised.byAi]).toEqual(["f0-2", "f0-5"]);
    expect(advised.unfilled).toEqual([
      { ref: "f0-1", label: "Anrede", required: true, reason: "a personal choice" },
      { ref: "f0-7", label: "Passwort", required: false, reason: REASONS.account },
    ]);
  });

  it("ignores advice the page can't take", () => {
    const advised = applyAdvice(
      plan,
      [
        { ref: "f0-0", key: "lastName", option: null, text: null, leave: null },
        { ref: "f0-1", key: null, option: "x", text: null, leave: null },
        { ref: "f0-1", key: null, option: null, text: "Frau", leave: null },
        { ref: "f0-3", key: "phone", option: null, text: null, leave: null },
        { ref: "nope", key: "salary", option: null, text: null, leave: null },
      ],
      controls,
      answers,
    );
    expect(advised.actions).toEqual(plan.actions);
    expect(advised.unfilled).toEqual(plan.unfilled);
  });
});
