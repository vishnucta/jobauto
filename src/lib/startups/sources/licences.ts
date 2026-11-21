import "server-only";

import { z } from "zod";

import { parseCsv } from "@/lib/csv";

import { getBytes, getJson, SourceError } from "../http";
import { companySite } from "../text";
import type { FoundStartup } from "../types";

// Firms newly licensed in Germany (jobauto fork), from ESMA's public
// registers: investment firms authorised by BaFin, EU investment firms that
// opened a branch in Germany, and crypto-asset service providers authorised
// under MiCA. A firm this new has to report to its regulator from the start
// (MiFIR transaction reporting, EMIR for derivatives, MiCA), usually before
// it advertises the job. Existing banks that only added crypto services
// (MiCA Article 60 notifications, mostly local co-operative banks) are left
// out: they rarely build a new team for it.

/** ESMA's interim MiCA register: one CSV of crypto-asset service providers, updated weekly. */
export const MICA_CASPS_CSV = "https://www.esma.europa.eu/sites/default/files/2024-12/CASPS.csv";
/** The search behind ESMA's registers site, for the register of investment firms (MiFID). */
export const ESMA_UPREG = "https://registers.esma.europa.eu/solr/esma_registers_upreg/select";
/** The registers as a person opens them, for the card's link. */
export const ESMA_REGISTERS_PAGE = "https://registers.esma.europa.eu/publication/searchRegister?core=esma_registers_upreg";
export const ESMA_MICA_PAGE = "https://www.esma.europa.eu/esmas-activities/digital-finance-and-innovation/markets-crypto-assets-regulation-mica";

/** Only firms licensed this recently: an older one has its team. */
export const LICENCE_WINDOW_DAYS = 365;

/** Why a firm without a job ad is worth writing to: the text "Write to them" starts the application from. */
const NO_AD =
  "No job ad: a firm this new is setting up its teams, and it has to report to its regulator from the start (MiFIR transaction reporting, EMIR for derivatives, MiCA for crypto-assets), with reconciliations behind it. " +
  "An unsolicited application (Initiativbewerbung) to whoever runs finance, operations or compliance is the way in.";

const day = (date: Date) => new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(date);

// ─── Reading the files ──────────────────────────────────────────────────────

/**
 * The MiCA file is UTF-8, but some lines carry Latin-1 bytes ("Stra\xdfe"):
 * each line is read as UTF-8 when it is, else as Windows-1252, so "Straße"
 * and "München" come out whole.
 */
export function decodeMixed(bytes: Uint8Array): string {
  const strict = new TextDecoder("utf-8", { fatal: true });
  const latin = new TextDecoder("windows-1252");
  const lines: string[] = [];
  let start = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  for (let index = start; index <= bytes.length; index++) {
    if (index < bytes.length && bytes[index] !== 0x0a) continue;
    const line = bytes.subarray(start, index);
    try {
      lines.push(strict.decode(line));
    } catch {
      lines.push(latin.decode(line));
    }
    start = index + 1;
  }
  return lines.join("\n");
}

/** "19/12/2025" as a date, or null. */
function registerDate(text: string): Date | null {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(text.trim());
  return match ? new Date(Date.UTC(Number(match[3]), Number(match[2]) - 1, Number(match[1]))) : null;
}

/**
 * The city in a register address, as "Frankfurt am Main, Germany": from
 * "Bockenheimer Anlage 46, 60322 Frankfurt am Main" or the investment firm
 * register's "Große Gallusstr. 16-18,60312,Frankfurt am Main,DE".
 */
export function cityFromAddress(address: string): string {
  const flat = address.replace(/\s+/g, " ").trim();
  const city =
    /,\s*\d{5}\s*,\s*([^,]+?)\s*(?:,|$)/.exec(flat)?.[1] ?? /\b\d{5}\s+([\p{L}][\p{L} .'-]*?)(?:\s*(?:,|\(|Germany|Deutschland|$))/iu.exec(flat)?.[1] ?? "";
  return city ? `${city.trim()}, Germany` : "Germany";
}

// ─── MiCA: crypto-asset service providers ───────────────────────────────────

/** A crypto-asset provider newly authorised in Germany (MiCA Article 63) as a firm to write to; null for anything else. */
export function firmFromCasp(row: Record<string, string>, now: Date): FoundStartup | null {
  if (row.ae_homeMemberState !== "DE" || !/article 63/i.test(row.ac_legal_basis ?? "") || row.ac_authorisationEndDate) return null;
  const authorised = registerDate(row.ac_authorisationNotificationDate ?? "");
  if (!authorised || now.getTime() - authorised.getTime() > LICENCE_WINDOW_DAYS * 86_400_000) return null;
  const company = (row.ae_lei_name || row.ae_commercial_name || "").trim();
  if (!company) return null;
  const site = /^https?:\/\//i.test(row.ae_website ?? "") ? row.ae_website : row.ae_website ? `https://${row.ae_website.replace(/^\/+/, "")}` : "";
  const services = (row.ac_serviceCode ?? "")
    .split("|")
    .map((service) => service.replace(/^\s*[a-z]\.\s*/i, "").trim())
    .filter(Boolean);
  return {
    source: "LICENCE",
    externalId: `mica:${row.ae_lei || company}`.slice(0, 120),
    company: company.slice(0, 200),
    website: site ? companySite(site) : "",
    summary: `New crypto-asset service provider, authorised under MiCA on ${day(authorised)}`,
    details: [
      `Authorised by ${row.ae_competentAuthority || "BaFin"} on ${day(authorised)} as a crypto-asset service provider (MiCA).`,
      services.length > 0 ? `Services: ${services.join("; ")}.` : "",
      row.ae_address ? `Address: ${row.ae_address}` : "",
      NO_AD,
    ]
      .filter(Boolean)
      .join("\n\n"),
    location: cityFromAddress(row.ae_address ?? ""),
    remote: null,
    stage: "Crypto-asset provider (MiCA)",
    roles: [],
    emails: [],
    links: [{ label: "MiCA register", url: ESMA_MICA_PAGE }],
    postedAt: authorised.toISOString(),
  };
}

/** Crypto-asset providers newly authorised in Germany. */
export async function fetchMicaFirms(signal: AbortSignal, now = new Date()): Promise<FoundStartup[]> {
  const rows = parseCsv(decodeMixed(await getBytes(MICA_CASPS_CSV, { signal })));
  if (rows.length > 0 && !("ae_homeMemberState" in rows[0])) throw new SourceError("changed its file");
  return rows.map((row) => firmFromCasp(row, now)).filter((firm): firm is FoundStartup => firm !== null);
}

// ─── MiFID: investment firms ────────────────────────────────────────────────

const firmSchema = z.object({
  id: z.string(),
  ae_entityName: z.string().catch(""),
  ae_commercialName: z.string().catch(""),
  ae_officeType: z.string().catch(""),
  ae_homeMemberState: z.string().catch(""),
  ae_hostMemberState: z.string().catch(""),
  ae_headOfficeAddress: z.string().catch(""),
  ae_branchAddress: z.string().catch(""),
  ae_competentAuthority: z.string().catch(""),
  ae_authorisationNotificationDate: z.string().catch(""),
  ae_website: z.string().catch(""),
  ae_status: z.string().catch(""),
});
type RegisterFirm = z.output<typeof firmSchema>;

const answerSchema = z.object({ response: z.object({ docs: z.array(z.unknown()) }) });

/** A firm as the register lists it, as a firm to write to; null for a shelf company, a closed firm or one that isn't in Germany. */
export function firmFromRegister(firm: RegisterFirm): FoundStartup | null {
  const branch = /branch/i.test(firm.ae_officeType);
  const inGermany = branch ? /germany/i.test(firm.ae_hostMemberState) : /germany/i.test(firm.ae_homeMemberState);
  if (!inGermany || (firm.ae_status && !/active/i.test(firm.ae_status))) return null;
  const company = (firm.ae_entityName || firm.ae_commercialName).trim();
  // A Vorratsgesellschaft is a shelf company, bought to be renamed later: no one to write to yet.
  if (!company || /vorratsgesellschaft/i.test(company)) return null;
  const authorised = new Date(firm.ae_authorisationNotificationDate);
  if (Number.isNaN(authorised.getTime())) return null;
  const address = (branch ? firm.ae_branchAddress : firm.ae_headOfficeAddress).replace(/\s+/g, " ").trim();
  const site = firm.ae_website.trim();
  return {
    source: "LICENCE",
    externalId: `mifid:${firm.id}`,
    company: company.slice(0, 200),
    website: site ? companySite(/^https?:\/\//i.test(site) ? site : `https://${site}`) : "",
    summary: branch ? `EU investment firm that opened a branch in Germany on ${day(authorised)}` : `New investment firm, authorised by BaFin on ${day(authorised)}`,
    details: [
      branch
        ? `An investment firm from elsewhere in the EU, supervised by ${firm.ae_competentAuthority || "its home regulator"}, notified its German branch on ${day(authorised)}.`
        : `Authorised by ${firm.ae_competentAuthority || "BaFin"} on ${day(authorised)} as an investment firm (MiFID).`,
      address ? `Address: ${address}` : "",
      NO_AD,
    ]
      .filter(Boolean)
      .join("\n\n"),
    location: cityFromAddress(address),
    remote: null,
    stage: branch ? "Branch in Germany" : "Investment firm",
    roles: [],
    emails: [],
    links: [{ label: "ESMA register", url: ESMA_REGISTERS_PAGE }],
    postedAt: authorised.toISOString(),
  };
}

/** The register's firms authorised since `since`, by a query on its own search. */
async function registerFirms(query: string, since: Date, signal: AbortSignal): Promise<RegisterFirm[]> {
  const params = new URLSearchParams({
    q: `type_s:parent AND ae_entityTypeCode:MIF AND ${query} AND ae_authorisationNotificationDate:[${since.toISOString()} TO NOW]`,
    rows: "500",
    sort: "ae_authorisationNotificationDate desc",
    fl: Object.keys(firmSchema.shape).join(","),
    wt: "json",
  });
  const answer = answerSchema.safeParse(await getJson(`${ESMA_UPREG}?${params}`, { signal }));
  if (!answer.success) throw new SourceError("changed its answer");
  return answer.data.response.docs.flatMap((doc) => {
    const firm = firmSchema.safeParse(doc);
    return firm.success ? [firm.data] : [];
  });
}

/** Investment firms newly authorised in Germany, and EU investment firms' new German branches. */
export async function fetchMifidFirms(signal: AbortSignal, now = new Date()): Promise<FoundStartup[]> {
  const since = new Date(now.getTime() - LICENCE_WINDOW_DAYS * 86_400_000);
  const [heads, branches] = await Promise.all([
    registerFirms('ae_homeMemberState:GERMANY AND ae_officeType:"Head office"', since, signal),
    registerFirms("ae_hostMemberState:GERMANY AND ae_officeType:Branch", since, signal),
  ]);
  return [...heads, ...branches].map(firmFromRegister).filter((firm): firm is FoundStartup => firm !== null);
}

/** Both registers; one failing doesn't lose the other's firms. */
export async function fetchLicensedFirms(signal: AbortSignal, now = new Date()): Promise<FoundStartup[]> {
  const [mica, mifid] = await Promise.allSettled([fetchMicaFirms(signal, now), fetchMifidFirms(signal, now)]);
  if (mica.status === "rejected" && mifid.status === "rejected") throw mica.reason;
  return [...(mica.status === "fulfilled" ? mica.value : []), ...(mifid.status === "fulfilled" ? mifid.value : [])];
}
