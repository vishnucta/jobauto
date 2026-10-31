// Many German postings, above all on the Bundesagentur's board, ask for
// applications by email ("Ihre Bewerbung senden Sie bitte an
// bewerbung@firma.de"). Found in the posting's text, that address is the
// better route than any form: Dossier's Email tab and Gmail sending already
// handle it, with the PDFs attached.

const ADDRESS = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
/** Addresses made for applications. */
const PREFERRED_LOCAL =
  /^(bewerbung|bewerbungen|bewerben|jobs?|karriere|career|careers|recruiting|recruitment|recruiter|hr|personal|personalabteilung|personalwesen|talent|talents|apply|application|applications|stellen|work|join|people|hiring)\b/i;
/** Addresses that take no applications. */
const EXCLUDED = /(no-?reply|noreply|datenschutz|privacy|dsgvo|gdpr|newsletter|presse|press|support|sales|webmaster|impressum|abuse|postmaster|example\.|sentry|wixpress|schema\.org)/i;
/** Words near an address that say it's where applications go. */
const CONTEXT = /bewerb|appl(y|ication)|unterlagen|lebenslauf|resume|\bcv\b|senden|schicken|richten|send|submit|e-?mail an|per e-?mail|via e-?mail|by e-?mail|kontakt|contact|ansprechpartner/i;

const WINDOW = 140;

/**
 * The address a posting says to apply to, or null. Each address is scored
 * by its local part and the words around it; one that reads as a
 * newsletter, privacy or no-reply address never wins.
 */
export function applyEmailIn(text: string): string | null {
  if (!text) return null;
  let best: { address: string; score: number } | null = null;
  for (const match of text.matchAll(ADDRESS)) {
    const address = match[0].replace(/[.,;:]+$/, "").toLowerCase();
    if (EXCLUDED.test(address)) continue;
    const local = address.slice(0, address.indexOf("@"));
    const around = text.slice(Math.max(0, match.index - WINDOW), match.index + address.length + WINDOW);
    let score = 1;
    if (PREFERRED_LOCAL.test(local)) score += 3;
    if (CONTEXT.test(around)) score += 2;
    if (/mailto:$/i.test(text.slice(Math.max(0, match.index - 7), match.index))) score += 1;
    if (!best || score > best.score) best = { address, score };
  }
  return best?.address ?? null;
}
