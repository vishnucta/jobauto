// A German cover letter's address block and greeting (jobauto fork), written
// in code rather than left to the model, which wrote "Northwind Capital GmbH ·
// Hiring team" and greeted the team although the posting named Herr
// Becker. As DIN 5008 has it: the company, then "z. Hd." and the person
// the posting names, then the place; the greeting by name. The sign-off is
// GERMAN_SIGN_OFF (letter-frame.ts), with no comma.

/** The person a posting names, read from how it writes them: "Herr Dr. Max Becker". */
export type Contact = {
  salutation: "Herr" | "Frau" | null;
  /** "Dr." or "Prof. Dr.", or "". */
  titles: string;
  /** The name without salutation and titles: "Max Becker". */
  name: string;
  surname: string;
};

const SALUTATIONS: Record<string, Contact["salutation"]> = { herr: "Herr", herrn: "Herr", "hr.": "Herr", frau: "Frau", "fr.": "Frau", mr: "Herr", "mr.": "Herr", mrs: "Frau", "mrs.": "Frau", ms: "Frau", "ms.": "Frau" };
const TITLE = /^(?:prof|dr|dipl)\.?(?:-\p{L}+\.?)?$/iu;
/** Lower-case words in a name: "Anna von Berg". */
const PARTICLES = new Set(["von", "van", "vom", "zu", "der", "den", "de", "di", "da", "la", "le"]);

/**
 * The contact person from the model's reading of the posting, or null when
 * there's none, it isn't a person's name (an address, a phone number, a
 * department), or the posting doesn't say it: a name the posting doesn't
 * contain is never written into a letter.
 */
export function readContact(text: string | null | undefined, posting: string): Contact | null {
  // Only the name, from what the posting says around it: "Ihr Ansprechpartner: Herrn Max Mustermann (mm@example.com), Teamleitung".
  const line = (text ?? "")
    .replace(/\([^)]*\)/g, " ")
    .replace(/\S+@\S+/g, " ")
    .replace(/^.*:\s*/, "")
    .replace(/[,;].*$/, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!line || line.length > 80 || /[@\d/\\|()]/.test(line)) return null;
  const words = line.split(" ");
  const salutation = SALUTATIONS[words[0].toLowerCase()] ?? null;
  if (salutation) words.shift();
  const titles: string[] = [];
  while (words.length > 1 && TITLE.test(words[0])) titles.push(words.shift()!);
  const name = words.join(" ");
  // "von Berg" from "Anna von Berg": the surname starts at its particle.
  const particle = words.findIndex((word, index) => index > 0 && PARTICLES.has(word));
  const surname = particle > 0 ? words.slice(particle).join(" ") : (words.at(-1) ?? "");
  // A name has capitalised words; "Personalabteilung" or "HR team" isn't one.
  if (!surname || words.length > 5 || !words.every((word) => /^\p{Lu}/u.test(word) || PARTICLES.has(word)) || /abteilung|team|recruiting|personal/i.test(name)) return null;
  if (!posting.toLowerCase().includes(surname.toLowerCase())) return null;
  return { salutation, titles: titles.join(" "), name, surname };
}

/**
 * The first person the posting names with Herr or Frau ("an Herrn Max
 * Mustermann"), for when the model gave no contact: German postings name
 * their contact so, and rarely anyone else.
 */
export function contactInPosting(posting: string): Contact | null {
  const found = posting.match(/\b(?:Herrn?|Frau)\s+(?:(?:Prof|Dr)\.\s*)*\p{Lu}[\p{L}'-]+(?:\s+(?:(?:von|van|vom|zu|de)\s+)?\p{Lu}[\p{L}'-]+){1,2}/u);
  return found ? readContact(found[0], posting) : null;
}

/** "Sehr geehrter Herr Dr. Becker,", or the usual greeting when no one is named. */
export function germanGreeting(contact: Contact | null): string {
  if (!contact) return "Sehr geehrte Damen und Herren,";
  const titled = (name: string) => [contact.titles, name].filter(Boolean).join(" ");
  if (contact.salutation === "Herr") return `Sehr geehrter Herr ${titled(contact.surname)},`;
  if (contact.salutation === "Frau") return `Sehr geehrte Frau ${titled(contact.surname)},`;
  // Without Herr or Frau, the whole name, which needs neither.
  return `Guten Tag ${titled(contact.name)},`;
}

/** The address block: the company, "z. Hd. Herrn Max Becker" or "Personalabteilung", then the place's lines. */
export function germanRecipient({ company, contact, place }: { company: string; contact: Contact | null; place: readonly string[] }): string {
  const person = contact && ["z. Hd.", contact.salutation === "Herr" ? "Herrn" : contact.salutation, contact.titles, contact.name].filter(Boolean).join(" ");
  return [company.trim(), person || "Personalabteilung", ...place].filter((line) => line.trim()).join("\n");
}
