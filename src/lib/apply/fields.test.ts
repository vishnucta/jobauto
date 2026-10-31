import { describe, expect, it } from "vitest";

import { buildAnswerSet, DEFAULT_APPLY_ANSWERS } from "./answers";
import { chooseOption, classify, fold, labelOf, planFill, REASONS, valueFor, type FormControl } from "./fields";

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
  basics: {
    name: "Erika Mustermann",
    email: "p@example.com",
    phone: "+49 170 1234567",
    address: "Musterstraße 12, 20095 Hamburg",
    city: "Hamburg",
    country: "Germany",
    linkedin: "https://www.linkedin.com/in/p",
    website: "",
    dob: "1985-01-15",
  },
  answers: { ...DEFAULT_APPLY_ANSWERS, salary: "55.000 € brutto/Jahr", startDate: "sofort", noticePeriod: "keine" },
  letterParagraphs: ["Sehr geehrte Damen und Herren,", "ich bewerbe mich."],
});

describe("classifying form controls (Phase A)", () => {
  it.each([
    [{ label: "Vorname *" }, "firstName"],
    [{ name: "candidate[first_name]" }, "firstName"],
    [{ autocomplete: "given-name" }, "firstName"],
    [{ label: "Nachname" }, "lastName"],
    [{ id: "applicant-last-name" }, "lastName"],
    [{ label: "E-Mail-Adresse", type: "email" }, "email"],
    [{ label: "Telefon", type: "tel" }, "phone"],
    [{ placeholder: "Mobile number" }, "phone"],
    [{ label: "Straße und Hausnummer" }, "street"],
    [{ label: "PLZ" }, "postalCode"],
    [{ label: "Ort" }, "city"],
    [{ label: "Wohnort" }, "city"],
    [{ label: "Land" }, "country"],
    [{ label: "Bundesland" }, "unknown"],
    [{ label: "LinkedIn Profil" }, "linkedin"],
    [{ name: "urls[LinkedIn]" }, "linkedin"],
    [{ label: "Gehaltsvorstellung (brutto/Jahr)" }, "salary"],
    [{ label: "Frühestmöglicher Eintrittstermin" }, "startDate"],
    [{ label: "Earliest start date" }, "startDate"],
    [{ label: "Kündigungsfrist" }, "noticePeriod"],
    [{ label: "Besitzen Sie eine gültige Arbeitserlaubnis für Deutschland?" }, "workPermit"],
    [{ label: "Do you require visa sponsorship?" }, "sponsorship"],
    [{ label: "Deutschkenntnisse" }, "germanLevel"],
    [{ label: "English level" }, "englishLevel"],
    [{ label: "Geburtsdatum", type: "date" }, "dob"],
    [{ label: "Anschreiben / Nachricht", tag: "textarea", type: "textarea" }, "message"],
    [{ label: "Nachricht" }, "unknown"],
    [{ label: "Warum möchten Sie bei uns arbeiten?", tag: "textarea", type: "textarea" }, "unknown"],
    [{ label: "Wunschgehalt" }, "salary"],
    [{ type: "email", label: "Kontakt" }, "email"],
    [{ label: "Name" }, "fullName"],
    [{ label: "Name des aktuellen Arbeitgebers" }, "unknown"],
    [{ label: "Wie sind Sie auf uns aufmerksam geworden?" }, "unknown"],
    [{ label: "Anrede", tag: "select", type: "select" }, "unknown"],
    [{ type: "hidden", name: "token" }, "ignore"],
    [{ type: "password", label: "Passwort" }, "password"],
    [{ type: "file", label: "Lebenslauf" }, "file:cv"],
    [{ type: "file", name: "resume" }, "file:cv"],
    [{ type: "file", label: "Anschreiben" }, "file:coverLetter"],
    [{ type: "file", label: "Weitere Unterlagen" }, "file:attachments"],
    [{ type: "checkbox", label: "Ich habe die Datenschutzerklärung gelesen" }, "consent"],
    [{ type: "checkbox", label: "I agree to the terms" }, "consent"],
    [{ type: "checkbox", label: "Ich möchte über weitere Stellen informiert werden" }, "optIn"],
    [{ type: "checkbox", label: "Ich besitze eine Arbeitserlaubnis" }, "workPermit"],
    [{ type: "radio", group: "Haben Sie eine Arbeitserlaubnis?", label: "Ja" }, "workPermit"],
  ] as [Partial<FormControl>, string][])("reads %o as %s", (over, target) => {
    expect(classify(control({ ref: "x", ...over }))).toBe(target);
  });

  it("folds umlauts and punctuation in names", () => {
    expect(fold("Straße_und-Hausnummer[0]")).toBe("strasse und hausnummer 0");
  });

  it("labels a control by what the user sees", () => {
    expect(labelOf(control({ ref: "x", label: "  Vorname * ", name: "fn" }))).toBe("Vorname");
    expect(labelOf(control({ ref: "x", name: "fn" }))).toBe("fn");
  });
});

describe("choosing options and values", () => {
  const options = (texts: string[]) => texts.map((text, index) => ({ value: String(index), text }));

  it("picks Germany, yes/no, a language level, and 'sofort'", () => {
    expect(chooseOption("country", "Germany", options(["Bitte wählen", "Österreich", "Deutschland"]))?.text).toBe("Deutschland");
    expect(chooseOption("workPermit", "yes", options(["--", "Nein", "Ja"]))?.text).toBe("Ja");
    expect(chooseOption("sponsorship", "no", options(["Yes", "No"]))?.text).toBe("No");
    expect(chooseOption("germanLevel", "A2", options(["Keine", "A1 – Anfänger", "A2 – Grundkenntnisse", "B1"]))?.text).toBe("A2 – Grundkenntnisse");
    expect(chooseOption("germanLevel", "A2", options(["Grundkenntnisse", "Gut", "Fließend"]))?.text).toBe("Grundkenntnisse");
    expect(chooseOption("englishLevel", "C1", options(["Basic", "Good", "Verhandlungssicher"]))?.text).toBe("Verhandlungssicher");
    expect(chooseOption("startDate", "sofort", options(["Bitte wählen", "Ab sofort", "In 3 Monaten"]))?.text).toBe("Ab sofort");
    expect(chooseOption("noticePeriod", "3 Monate", options(["keine", "1 Monat", "3 Monate"]))?.text).toBe("3 Monate");
    expect(chooseOption("salary", "55.000 €", options(["< 40.000", "40.000–60.000"]))).toBeNull();
  });

  it("types dates and numbers the way the input takes them", () => {
    expect(valueFor("dob", "1985-01-15", "text")).toBe("15.01.1985");
    expect(valueFor("dob", "1985-01-15", "date")).toBe("1985-01-15");
    expect(valueFor("startDate", "sofort", "date")).toBeNull();
    expect(valueFor("startDate", "01.12.2026", "date")).toBe("2026-12-01");
    expect(valueFor("salary", "55.000 € brutto/Jahr", "number")).toBe("55000");
    expect(valueFor("workPermit", "yes", "text")).toBe("Ja");
    expect(valueFor("email", "", "email")).toBeNull();
  });
});

describe("planning the fill of a German form", () => {
  const form: FormControl[] = [
    control({ ref: "f0-0", tag: "select", type: "select", label: "Anrede", options: [{ value: "", text: "Bitte wählen" }, { value: "f", text: "Frau" }, { value: "m", text: "Herr" }], required: true }),
    control({ ref: "f0-1", label: "Vorname", required: true }),
    control({ ref: "f0-2", label: "Nachname", required: true }),
    control({ ref: "f0-3", type: "email", label: "E-Mail", required: true }),
    control({ ref: "f0-4", type: "tel", label: "Telefon" }),
    control({ ref: "f0-5", label: "Straße" }),
    control({ ref: "f0-6", label: "PLZ" }),
    control({ ref: "f0-7", label: "Ort", value: "Hamburg" }),
    control({ ref: "f0-8", tag: "select", type: "select", label: "Land", options: [{ value: "", text: "Bitte wählen" }, { value: "AT", text: "Österreich" }, { value: "DE", text: "Deutschland" }] }),
    control({ ref: "f0-9", label: "Gehaltsvorstellung" }),
    control({ ref: "f0-10", type: "date", label: "Frühester Eintrittstermin" }),
    control({ ref: "f0-11", label: "Kündigungsfrist" }),
    control({ ref: "f0-12", type: "radio", name: "permit", group: "Besitzen Sie eine Arbeitserlaubnis?", label: "Ja", value: "1" }),
    control({ ref: "f0-13", type: "radio", name: "permit", group: "Besitzen Sie eine Arbeitserlaubnis?", label: "Nein", value: "0" }),
    control({ ref: "f0-14", tag: "select", type: "select", label: "Deutschkenntnisse", options: [{ value: "", text: "Bitte wählen" }, { value: "1", text: "Grundkenntnisse (A1–A2)" }, { value: "2", text: "Gut (B1–B2)" }, { value: "3", text: "Verhandlungssicher (C1–C2)" }] }),
    control({ ref: "f0-15", type: "file", label: "Lebenslauf", required: true }),
    control({ ref: "f0-16", type: "file", label: "Anschreiben" }),
    control({ ref: "f0-17", type: "file", label: "Weitere Unterlagen", multiple: true }),
    control({ ref: "f0-18", tag: "textarea", type: "textarea", label: "Nachricht an uns" }),
    control({ ref: "f0-19", type: "checkbox", label: "Ich habe die Datenschutzerklärung gelesen und akzeptiere sie", required: true }),
    control({ ref: "f0-20", type: "checkbox", label: "Ich möchte den Newsletter erhalten" }),
    control({ ref: "f0-21", type: "password", label: "Passwort" }),
    control({ ref: "f0-22", type: "hidden", name: "csrf", value: "abc" }),
    control({ ref: "f0-23", label: "Wie sind Sie auf uns aufmerksam geworden?" }),
  ];

  it("fills what it knows, uploads the PDFs once each, and leaves the rest to the user", () => {
    const plan = planFill(form, answers, { cv: true, coverLetter: true });
    const byRef = Object.fromEntries(plan.actions.map((action) => [action.ref, action]));
    expect(byRef["f0-1"]).toMatchObject({ kind: "type", key: "firstName", value: "Erika" });
    expect(byRef["f0-2"]).toMatchObject({ kind: "type", key: "lastName", value: "Mustermann" });
    expect(byRef["f0-3"]).toMatchObject({ kind: "type", key: "email", value: "p@example.com" });
    expect(byRef["f0-5"]).toMatchObject({ kind: "type", key: "street", value: "Musterstraße 12" });
    expect(byRef["f0-6"]).toMatchObject({ kind: "type", key: "postalCode", value: "20095" });
    expect(byRef["f0-8"]).toMatchObject({ kind: "select", key: "country", value: "DE" });
    expect(byRef["f0-9"]).toMatchObject({ kind: "type", key: "salary", value: "55.000 € brutto/Jahr" });
    expect(byRef["f0-11"]).toMatchObject({ kind: "type", key: "noticePeriod", value: "keine" });
    expect(byRef["f0-12"]).toMatchObject({ kind: "check", key: "workPermit" });
    expect(byRef["f0-13"]).toBeUndefined();
    expect(byRef["f0-14"]).toMatchObject({ kind: "select", key: "germanLevel", value: "1" });
    expect(byRef["f0-15"]).toMatchObject({ kind: "upload", files: ["cv"] });
    expect(byRef["f0-16"]).toMatchObject({ kind: "upload", files: ["coverLetter"] });
    expect(byRef["f0-17"]).toBeUndefined();
    expect(byRef["f0-18"]).toMatchObject({ kind: "type", key: "message", value: "Sehr geehrte Damen und Herren,\n\nich bewerbe mich." });
    expect(byRef["f0-19"]).toMatchObject({ kind: "check", key: "consent" });
    expect(byRef["f0-20"]).toBeUndefined();
    expect(byRef["f0-22"]).toBeUndefined();

    // Already there: left alone.
    expect(plan.kept).toEqual([{ ref: "f0-7", label: "Ort" }]);

    // Left to the user, required first.
    expect(plan.unfilled.map((entry) => [entry.label, entry.required, entry.reason])).toEqual([
      ["Anrede", true, REASONS.unknown],
      ["Frühester Eintrittstermin", false, REASONS.needsDay],
      ["Passwort", false, REASONS.account],
      ["Wie sind Sie auf uns aufmerksam geworden?", false, REASONS.unknown],
    ]);
  });

  it("puts the letter into 'other documents' when there is no letter input, and nothing twice", () => {
    const plan = planFill(
      [control({ ref: "a", type: "file", label: "CV", required: true }), control({ ref: "b", type: "file", label: "Other documents", multiple: true })],
      answers,
      { cv: true, coverLetter: true },
    );
    expect(plan.actions).toEqual([
      { kind: "upload", ref: "a", label: "CV", role: "cv", files: ["cv"] },
      { kind: "upload", ref: "b", label: "Other documents", role: "attachments", files: ["coverLetter"] },
    ]);
  });

  it("uploads both into one 'documents' input when that's all there is", () => {
    const plan = planFill([control({ ref: "a", type: "file", label: "Bewerbungsunterlagen", multiple: true, required: true })], answers, { cv: true, coverLetter: true });
    expect(plan.actions).toEqual([{ kind: "upload", ref: "a", label: "Bewerbungsunterlagen", role: "attachments", files: ["cv", "coverLetter"] }]);
    const single = planFill([control({ ref: "a", type: "file", label: "Dokument" })], answers, { cv: true, coverLetter: false });
    expect(single.actions[0]).toMatchObject({ files: ["cv"] });
  });

  it("says when a required PDF is missing", () => {
    const plan = planFill([control({ ref: "a", type: "file", label: "Anschreiben", required: true })], answers, { cv: true, coverLetter: false });
    expect(plan.unfilled).toEqual([{ ref: "a", label: "Anschreiben", required: true, reason: REASONS.noFile }]);
  });

  it("asks for answers that aren't saved yet instead of guessing", () => {
    const blank = { ...answers, salary: "", phone: "" };
    const plan = planFill([control({ ref: "a", label: "Salary expectation", required: true }), control({ ref: "b", type: "tel", label: "Phone" })], blank, { cv: true, coverLetter: false });
    expect(plan.actions).toEqual([]);
    expect(plan.unfilled.map((entry) => entry.reason)).toEqual([REASONS.noAnswer, REASONS.noAnswer]);
  });

  it("picks the sponsorship radio the other way round", () => {
    const plan = planFill(
      [
        control({ ref: "y", type: "radio", name: "sponsor", group: "Will you require sponsorship?", label: "Yes" }),
        control({ ref: "n", type: "radio", name: "sponsor", group: "Will you require sponsorship?", label: "No" }),
      ],
      answers,
      { cv: false, coverLetter: false },
    );
    expect(plan.actions).toEqual([{ kind: "check", ref: "n", label: "Will you require sponsorship?: No", key: "sponsorship" }]);
  });

  it("leaves a radio group alone once one is chosen", () => {
    const plan = planFill(
      [
        control({ ref: "y", type: "radio", name: "p", group: "Arbeitserlaubnis?", label: "Ja", checked: true }),
        control({ ref: "n", type: "radio", name: "p", group: "Arbeitserlaubnis?", label: "Nein" }),
      ],
      answers,
      { cv: false, coverLetter: false },
    );
    expect(plan.actions).toEqual([]);
    expect(plan.kept).toEqual([{ ref: "y", label: "Arbeitserlaubnis?" }]);
  });
});
