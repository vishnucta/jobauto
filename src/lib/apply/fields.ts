import { ANSWER_LABELS, type AnswerKey, type AnswerSet, type LanguageLevelAnswer } from "./answers";

// Matching an employer's form to the user's answers (Phase A), without a
// browser: the page's controls come in as plain data (scanControls in
// form.ts), and a plan of what to type, pick, tick and upload goes out,
// with the fields that need the user herself. German and English labels,
// names and ids are read; nothing is typed into a field that isn't
// understood, and nothing a form already holds is overwritten.

/** One form control as the page scan reports it. */
export type FormControl = {
  /** How the browser finds it again (a data attribute set by the scan). */
  ref: string;
  tag: "input" | "select" | "textarea";
  /** The input's type, lower case; "select" or "textarea" for those. */
  type: string;
  name: string;
  id: string;
  label: string;
  placeholder: string;
  autocomplete: string;
  aria: string;
  /** The question a radio, checkbox or grouped field belongs to (its fieldset's legend or nearest heading). */
  group: string;
  required: boolean;
  value: string;
  checked: boolean;
  options: { value: string; text: string }[];
  multiple: boolean;
  accept: string;
};

export type FileKind = "cv" | "coverLetter";
export type FileRole = FileKind | "attachments";

export type FillAction =
  | { kind: "type"; ref: string; label: string; key: AnswerKey; value: string }
  | { kind: "select"; ref: string; label: string; key: AnswerKey; value: string; text: string }
  | { kind: "check"; ref: string; label: string; key: AnswerKey | "consent" }
  | { kind: "upload"; ref: string; label: string; role: FileRole; files: FileKind[] };

export type Unfilled = { ref: string; label: string; required: boolean; reason: string };

export type FillPlan = {
  actions: FillAction[];
  /** Fields left to the user, required ones first. */
  unfilled: Unfilled[];
  /** Fields that already held a value, left as they were. */
  kept: { ref: string; label: string }[];
};

export type Target = AnswerKey | "consent" | "optIn" | "password" | `file:${FileRole}` | "ignore" | "unknown";

export const REASONS = {
  unknown: "I don't know what goes here",
  account: "needs an account on the site",
  noAnswer: "no answer saved for it yet",
  noOption: "none of the options matched",
  needsDay: "needs a calendar day",
  noFile: "no PDF to attach",
} as const;

/** Lower case, umlauts folded, punctuation in names and ids turned into spaces. */
export function fold(text: string): string {
  return text
    .toLowerCase()
    .replace(/ä/g, "a")
    .replace(/ö/g, "o")
    .replace(/ü/g, "u")
    .replace(/ß/g, "ss")
    .replace(/[_\-[\]./:()*]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const haystack = (control: FormControl) => fold([control.autocomplete, control.name, control.id, control.label, control.aria, control.placeholder, control.group].join(" | "));

/** What to call a control on screen. */
export function labelOf(control: FormControl): string {
  const own = [control.label, control.aria, control.placeholder, control.group, control.name, control.id].map((text) => text.trim()).find(Boolean) ?? "Field";
  return own.replace(/\s+/g, " ").replace(/\s*\*\s*$/, "").slice(0, 120);
}

const TEXT_TYPES = new Set(["", "text", "email", "tel", "url", "number", "search", "date", "textarea"]);
const IGNORED_TYPES = new Set(["hidden", "submit", "button", "reset", "image", "color", "range", "time", "week", "month", "datetime-local"]);

/** Text-like fields, first match wins. */
const TEXT_RULES: readonly [AnswerKey, RegExp][] = [
  ["email", /\be ?mail\b|\bemail\b/],
  ["phone", /\b(tel|telefon|telefonnummer|phone|mobile|mobil|handy|rufnummer|mobilnummer)\b/],
  ["linkedin", /linkedin/],
  ["website", /\b(website|webseite|homepage|portfolio|github|xing|url)\b/],
  ["firstName", /\b(given name|vorname|first ?name|firstname|forename|fname|rufname)\b/],
  ["lastName", /\b(family name|nachname|last ?name|lastname|surname|familienname|lname|zuname)\b/],
  ["postalCode", /\b(postal code|plz|postleitzahl|zip|zipcode|postal|postcode|post code)\b/],
  ["city", /\b(address level2|stadt|ort|wohnort|city|town|locality)\b/],
  ["street", /\b(street address|address line1|stra(ss|ß)e|street|anschrift|adresse|address|hausnummer)\b/],
  ["dob", /\b(bday|geburtsdatum|geburtstag|date of birth|birth ?date|birthday|dob|geboren)\b/],
  ["salary", /\b(gehalt|gehaltsvorstellung|gehaltsvorstellungen|gehaltswunsch|wunschgehalt|zielgehalt|salary|compensation|verg(u|ue)tung|jahresgehalt|bruttogehalt|bruttojahresgehalt)\b/],
  ["noticePeriod", /\b(k(u|ue)ndigungsfrist|notice period|notice)\b/],
  [
    "startDate",
    /\b(eintritt|eintrittstermin|eintrittsdatum|start ?date|startdatum|startzeitpunkt|starttermin|verf(u|ue)gbar|verf(u|ue)gbarkeit|availability|available|fr(u|ue)hest|fr(u|ue)hestm(o|oe)glich|earliest|beginn|arbeitsbeginn|starting)\b/,
  ],
  ["sponsorship", /\b(sponsor|sponsorship|sponsoring)\b/],
  [
    "workPermit",
    /\b(arbeitserlaubnis|arbeitsgenehmigung|work permit|work authori[sz]ation|authori[sz]ed to work|right to work|eligible to work|eligibility|visum|visa|aufenthaltstitel|aufenthaltserlaubnis|legally)\b/,
  ],
  ["germanLevel", /\b(deutschkenntnisse|deutsch|german)\b/],
  ["englishLevel", /\b(englischkenntnisse|englisch|english)\b/],
  [
    "message",
    // The letter goes into a "message" box; an open question ("Warum möchten Sie…?") is left for the model to answer.
    /\b(anschreiben|motivation|motivationsschreiben|cover ?letter|coverletter|nachricht|message|bemerkung|bemerkungen|anmerkung|anmerkungen|kommentar|comment|comments|additional|weitere informationen|sonstiges)\b/,
  ],
  ["fullName", /\b(name|full ?name|fullname|vollstandiger name|vor und nachname)\b/],
  ["country", /\b(land|country|country name|staat|nation)\b/],
];

/** Words that mean a field isn't about the candidate's own details after all: stems, then whole short words. */
const NOT_THE_CANDIDATE =
  /\b(firma|company|unternehmen|arbeitgeber|employer|position|job ?title|jobtitel|stellenbezeichnung|referenz|reference|how did you|wie sind sie|aufmerksam|gender|geschlecht|anrede|salutation|nationalit|staatsangeh|user ?name|benutzername|login|bundesland|province)|\b(quelle|source|titel|title|state|region)\b/;
/** Rules that a "not the candidate" hint overrules; the rest are specific enough. */
const HINT_SENSITIVE = new Set<AnswerKey>(["fullName", "city", "street", "country", "message", "website"]);

const OPT_IN = /newsletter|talent ?pool|talentpool|informiert|benachrichtig|zukunftig|future|marketing|keep me|other positions|weitere stellen|updates|job ?alert/;
const CONSENT =
  /datenschutz|privacy|einwilligung|einverstandnis|einverstanden|consent|zustimm|akzeptier|agree|accept|terms|\bagb\b|nutzungsbedingungen|kenntnis|bedingungen|gelesen|policy|richtlinie|dsgvo|gdpr|speicherung|verarbeitung|processing/;
const PERMIT_CHECK = /arbeitserlaubnis|arbeitsgenehmigung|work permit|authori[sz]ed to work|right to work|eligible/;

const CV_FILE = /lebenslauf|\bcv\b|resume|curriculum|vitae/;
const LETTER_FILE = /anschreiben|cover|motivation/;

const YES = /^(ja|yes|y)\b/;
const NO = /^(nein|no|n)\b/;

const LEVEL_CODES: Record<LanguageLevelAnswer, RegExp> = {
  A1: /\ba1\b/,
  A2: /\ba2\b/,
  B1: /\bb1\b/,
  B2: /\bb2\b/,
  C1: /\bc1\b/,
  C2: /\bc2\b/,
  native: /muttersprach|native|mother tongue/,
};
const LEVEL_WORDS: Record<LanguageLevelAnswer, RegExp> = {
  A1: /anfanger|beginner|grundlagen|elementary|basic/,
  A2: /grundkenntnisse|elementary|basic|grundlegend/,
  B1: /intermediate|konversation|conversational|fortgeschritten|\bgut\b/,
  B2: /upper|sehr gut|\bgood\b|fliessend|fluent|selbststandig/,
  C1: /verhandlungssicher|advanced|fluent|business|proficient/,
  C2: /proficient|mastery|nahezu muttersprach|near native|exzellent|excellent/,
  native: /muttersprach|native|mother tongue/,
};
const PLACEHOLDER_OPTION = /^(bitte|please|select|wahlen|auswahlen|choose|keine angabe|none|--|…|\.\.\.|$)/;

function textKey(control: FormControl): AnswerKey | "unknown" {
  // An input's type says what it takes, whatever it's called.
  if (control.type === "email") return "email";
  if (control.type === "tel") return "phone";
  const hay = haystack(control);
  for (const [key, pattern] of TEXT_RULES) {
    if (!pattern.test(hay)) continue;
    if (HINT_SENSITIVE.has(key) && NOT_THE_CANDIDATE.test(hay)) return "unknown";
    // A short input asking for a "message" is something else; only a textarea takes the letter.
    if (key === "message" && control.tag !== "textarea") return "unknown";
    return key;
  }
  return "unknown";
}

/** What a control is for. */
export function classify(control: FormControl): Target {
  if (control.tag === "input" && IGNORED_TYPES.has(control.type)) return "ignore";
  if (control.type === "password") return "password";
  if (control.type === "file") {
    const hay = haystack(control);
    if (CV_FILE.test(hay)) return "file:cv";
    if (LETTER_FILE.test(hay)) return "file:coverLetter";
    return "file:attachments";
  }
  if (control.type === "checkbox") {
    const hay = fold([control.label, control.aria, control.group, control.name].join(" "));
    if (OPT_IN.test(hay)) return "optIn";
    if (PERMIT_CHECK.test(hay)) return "workPermit";
    if (CONSENT.test(hay)) return "consent";
    return "unknown";
  }
  if (control.type === "radio") {
    const hay = fold([control.group, control.name, control.aria].join(" "));
    for (const key of ["sponsorship", "workPermit", "germanLevel", "englishLevel"] as const) {
      if (TEXT_RULES.find(([rule]) => rule === key)![1].test(hay)) return key;
    }
    return "unknown";
  }
  if (control.tag === "select" || TEXT_TYPES.has(control.type)) return textKey(control);
  return "unknown";
}

/** The option to pick for a key's answer, or null. */
export function chooseOption(key: AnswerKey, answer: string, options: FormControl["options"]): FormControl["options"][number] | null {
  const usable = options.filter((option) => !PLACEHOLDER_OPTION.test(fold(option.text)));
  const find = (pattern: RegExp) => usable.find((option) => pattern.test(fold(option.text)) || pattern.test(fold(option.value))) ?? null;
  switch (key) {
    case "country":
      return find(/deutschland|germany|\bde\b|\bdeu\b/) ?? find(new RegExp(`^${escape(fold(answer))}$`));
    case "workPermit":
      return find(answer === "yes" ? YES : NO);
    case "sponsorship":
      return find(answer === "yes" ? YES : NO);
    case "germanLevel":
    case "englishLevel": {
      const level = answer as LanguageLevelAnswer;
      if (!(level in LEVEL_CODES)) return null;
      return find(LEVEL_CODES[level]) ?? find(LEVEL_WORDS[level]);
    }
    case "startDate":
      if (/sofort|immediately|asap|as soon|jederzeit|now/.test(fold(answer))) return find(/sofort|immediately|asap|as soon|jederzeit|now/);
      return find(new RegExp(`^${escape(fold(answer))}$`)) ?? find(new RegExp(escape(fold(answer))));
    default: {
      const wanted = fold(answer);
      if (!wanted) return null;
      return find(new RegExp(`^${escape(wanted)}$`)) ?? find(new RegExp(escape(wanted)));
    }
  }
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** "1990-05-04" → "04.05.1990"; anything else as it is. */
const germanDate = (iso: string) => (/^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso.split("-").reverse().join(".") : iso);
/** "04.05.1990" → "1990-05-04"; an ISO day as it is; null for anything else. */
const isoDate = (text: string) => {
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const german = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(text);
  return german ? `${german[3]}-${german[2]}-${german[1]}` : null;
};

/** The value to type for a key into an input of `type`, or null when it can't be typed there. */
export function valueFor(key: AnswerKey, answer: string, type: string): string | null {
  if (!answer) return null;
  if (type === "date") return isoDate(answer);
  if (type === "number") {
    const digits = answer.replace(/[^\d]/g, "");
    return digits || null;
  }
  if (key === "dob") return germanDate(answer);
  if (key === "workPermit" || key === "sponsorship") return answer === "yes" ? "Ja" : "Nein";
  return answer;
}

/** The plan for a page's controls: what to fill from the answers, and what's left to the user. */
export function planFill(controls: readonly FormControl[], answers: AnswerSet, files: Record<FileKind, boolean>): FillPlan {
  const actions: FillAction[] = [];
  const unfilled: Unfilled[] = [];
  const kept: FillPlan["kept"] = [];
  const leave = (control: FormControl, reason: string, label = labelOf(control)) => unfilled.push({ ref: control.ref, label, required: control.required, reason });

  // Files: the dedicated inputs first, then "other documents" gets what's left.
  const assigned = new Set<FileKind>();
  const attachmentInputs: FormControl[] = [];
  for (const control of controls) {
    if (control.type !== "file") continue;
    const target = classify(control);
    if (target === "file:attachments") {
      attachmentInputs.push(control);
      continue;
    }
    const kind: FileKind = target === "file:cv" ? "cv" : "coverLetter";
    if (files[kind] && !assigned.has(kind)) {
      assigned.add(kind);
      actions.push({ kind: "upload", ref: control.ref, label: labelOf(control), role: kind, files: [kind] });
    } else if (control.required) leave(control, REASONS.noFile);
  }
  for (const control of attachmentInputs) {
    const left = (["cv", "coverLetter"] as const).filter((kind) => files[kind] && !assigned.has(kind));
    const chosen = control.multiple ? left : left.slice(0, 1);
    if (chosen.length > 0) {
      for (const kind of chosen) assigned.add(kind);
      actions.push({ kind: "upload", ref: control.ref, label: labelOf(control), role: "attachments", files: chosen });
    } else if (control.required) leave(control, REASONS.noFile);
  }

  // Radios: one choice per group.
  const groups = new Map<string, FormControl[]>();
  for (const control of controls) {
    if (control.type !== "radio") continue;
    const groupKey = control.name || control.group || control.ref;
    groups.set(groupKey, [...(groups.get(groupKey) ?? []), control]);
  }
  for (const radios of groups.values()) {
    const first = radios[0];
    const question = first.group || first.aria || first.name || "Choice";
    if (radios.some((radio) => radio.checked)) {
      kept.push({ ref: first.ref, label: question });
      continue;
    }
    const target = classify(first);
    if (target === "unknown" || target === "ignore" || target === "password" || target === "consent" || target === "optIn" || target.startsWith("file:")) {
      leave(first, REASONS.unknown, question);
      continue;
    }
    const key = target as AnswerKey;
    const answer = answers[key];
    const options = radios.map((radio) => ({ value: radio.ref, text: radio.label || radio.aria || radio.value }));
    const picked = answer ? chooseOption(key, answer, options) : null;
    if (picked) actions.push({ kind: "check", ref: picked.value, label: `${question}: ${picked.text}`, key });
    else leave(first, answer ? REASONS.noOption : REASONS.noAnswer, question);
  }

  // Everything else.
  for (const control of controls) {
    if (control.type === "file" || control.type === "radio") continue;
    const target = classify(control);
    if (target === "ignore" || target === "optIn") continue;
    const label = labelOf(control);
    if (target === "password") {
      leave(control, REASONS.account);
      continue;
    }
    if (control.type === "checkbox") {
      if (control.checked) {
        kept.push({ ref: control.ref, label });
        continue;
      }
      if (target === "consent") actions.push({ kind: "check", ref: control.ref, label, key: "consent" });
      else if (target === "workPermit") {
        if (answers.workPermit === "yes") actions.push({ kind: "check", ref: control.ref, label, key: "workPermit" });
      } else if (control.required) leave(control, REASONS.unknown);
      continue;
    }
    if (target === "unknown") {
      if (control.value.trim() || (control.tag === "select" && control.value && !PLACEHOLDER_OPTION.test(fold(control.options.find((o) => o.value === control.value)?.text ?? "")))) {
        kept.push({ ref: control.ref, label });
      } else leave(control, REASONS.unknown);
      continue;
    }
    const key = target as AnswerKey;
    const answer = answers[key];
    if (control.tag === "select") {
      const current = control.options.find((option) => option.value === control.value);
      if (current && !PLACEHOLDER_OPTION.test(fold(current.text))) {
        kept.push({ ref: control.ref, label });
        continue;
      }
      if (!answer) {
        leave(control, REASONS.noAnswer);
        continue;
      }
      const option = chooseOption(key, answer, control.options);
      if (option) actions.push({ kind: "select", ref: control.ref, label, key, value: option.value, text: option.text });
      else leave(control, REASONS.noOption);
      continue;
    }
    if (control.value.trim()) {
      kept.push({ ref: control.ref, label });
      continue;
    }
    if (!answer) {
      leave(control, REASONS.noAnswer);
      continue;
    }
    const value = valueFor(key, answer, control.type);
    if (value === null) leave(control, control.type === "date" ? REASONS.needsDay : REASONS.noAnswer);
    else actions.push({ kind: "type", ref: control.ref, label, key, value });
  }

  unfilled.sort((a, b) => Number(b.required) - Number(a.required));
  return { actions, unfilled, kept };
}

/** "First name", "Salary expectation"…: what an action filled, for the report. */
export function describeKey(key: AnswerKey | "consent"): string {
  return key === "consent" ? "Consent to data processing" : ANSWER_LABELS[key];
}
