import { parseCsv } from "@/lib/csv";
import { normalText } from "@/lib/job-search/search";

// Her network (jobauto fork): her LinkedIn connections, from the
// Connections.csv LinkedIn's own data export gives her, matched to the
// employers of postings, careers pages and new firms, so "you know someone
// here" shows where a referral is possible. Referrals are the quickest way
// into a team that works in English.

/** A connection as the screens show it. */
export type Person = { id: string; name: string; position: string; company: string; url: string };

/** Legal forms and filler that say nothing about which company it is. */
const LEGAL = new Set(
  "gmbh mbh ag se kg kgaa ohg gbr ug co cokg eg ev ltd limited plc llc llp inc corp corporation sa sas sarl spa bv nv ab as oy group gruppe holding holdings international deutschland germany europe the und and".split(" "),
);

/** A company's name folded for matching: "Berenberg Bank GmbH & Co. KG" → "berenberg bank". */
export function companyKey(name: string): string {
  return normalText(name)
    .split(" ")
    .filter((word) => word && !LEGAL.has(word))
    .join(" ");
}

/**
 * Whether two folded names are the same employer: equal, or one is the
 * other with more words ("hays" and "hays professional solutions"), when the
 * shorter has at least four letters, so "ag" or "sap" alone don't match a
 * dozen companies.
 */
export function sameCompany(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length >= 4 && ` ${long} `.includes(` ${short} `);
}

/** A row of the export, as stored. */
export type ConnectionRow = { firstName: string; lastName: string; company: string; position: string; url: string; connectedOn: Date | null; companyKey: string };

/** "05 Nov 2024" as a date, or null. */
function connectedOn(text: string): Date | null {
  const time = Date.parse(`${text.trim()} UTC`);
  return Number.isFinite(time) ? new Date(time) : null;
}

/**
 * The connections in LinkedIn's Connections.csv: its notes come before the
 * header row, which starts with "First Name". Null when it isn't that file.
 */
export function parseConnections(text: string): ConnectionRow[] | null {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  const header = lines.findIndex((line) => /^"?first name"?\s*,/i.test(line.trim()));
  if (header < 0) return null;
  return parseCsv(lines.slice(header).join("\n"))
    .map((row) => {
      const company = (row["Company"] ?? "").trim();
      const url = (row["URL"] ?? "").trim();
      return {
        firstName: (row["First Name"] ?? "").trim(),
        lastName: (row["Last Name"] ?? "").trim(),
        company,
        position: (row["Position"] ?? "").trim(),
        url: /^https?:\/\//i.test(url) ? url : "",
        connectedOn: connectedOn(row["Connected On"] ?? ""),
        companyKey: companyKey(company),
      };
    })
    .filter((row) => (row.firstName || row.lastName) && row.companyKey);
}

/** How a screen names the people she knows at a company: "Sam Doe (Head of Finance) and 2 more". */
export function knownLine(people: readonly Person[]): string {
  const [first, ...rest] = people;
  if (!first) return "";
  const who = first.position ? `${first.name} (${first.position})` : first.name;
  return rest.length === 0 ? who : `${who} and ${rest.length} more`;
}
