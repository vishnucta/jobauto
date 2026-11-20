import { permitClaimed, type ApplyAnswers } from "@/lib/apply/answers";
import { documentLabels } from "@/lib/document-labels";
import { experienceMonths, formatDateRange, paidRoles, type ProfileData } from "@/lib/profile";

// The Kurzprofil (jobauto fork): the one-page candidate profile German
// recruitment agencies pitch candidates with, in German. Key facts first
// (experience, focus, languages, availability, salary, work permit, where
// she'd work), then the roles and education in one line each. Everything
// comes from the profile and the standard answers, nothing is written by AI.

export type Kurzprofil = {
  name: string;
  headline: string;
  /** Email, phone, city: what an agency needs to reach her. */
  contact: string[];
  /** Label and value, in German. */
  facts: [string, string][];
  roles: { title: string; company: string; dates: string }[];
  education: { degree: string; school: string; dates: string }[];
};

const MAX_ROLES = 6;
const MAX_FOCUS = 8;

// Language and country names as the profile usually has them, in German.
const GERMAN_NAMES: Record<string, string> = {
  english: "Englisch", german: "Deutsch", french: "Französisch", spanish: "Spanisch", italian: "Italienisch", portuguese: "Portugiesisch",
  dutch: "Niederländisch", polish: "Polnisch", russian: "Russisch", turkish: "Türkisch", arabic: "Arabisch", chinese: "Chinesisch",
  mandarin: "Mandarin", japanese: "Japanisch", korean: "Koreanisch", greek: "Griechisch", swedish: "Schwedisch", danish: "Dänisch",
  germany: "Deutschland", india: "Indien", ireland: "Irland", austria: "Österreich", switzerland: "Schweiz", netherlands: "Niederlande",
};
const inGerman = (name: string) => GERMAN_NAMES[name.trim().toLowerCase()] ?? name.trim();

/** A bare amount such as "55000" as "55.000 € brutto/Jahr"; anything she wrote out stays as it is. */
function salaryText(salary: string): string {
  const amount = /^(\d{1,3}(?:[.,\s]?\d{3})+|\d+)\s*(?:€|eur|euro)?$/i.exec(salary.trim());
  if (!amount) return salary.trim();
  return `${Number(amount[1]!.replace(/[.,\s]/g, "")).toLocaleString("de-DE")} € brutto/Jahr`;
}

/** "sofort", or a day as "1. März 2027". */
function startText(startDate: string): string {
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(startDate.trim());
  if (!day) return startDate.trim();
  return new Intl.DateTimeFormat("de-DE", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(Date.UTC(Number(day[1]), Number(day[2]) - 1, Number(day[3])));
}

export function kurzprofil(
  profile: Pick<ProfileData, "basics" | "skills" | "languages" | "experience" | "education">,
  answers: Pick<ApplyAnswers, "salary" | "startDate" | "noticePeriod" | "workPermit" | "confirmed" | "germanCourse" | "degreeRecognition" | "mobility">,
  today: Date,
): Kurzprofil {
  const labels = documentLabels("German");
  const options = { locale: "de-DE", present: labels.present };
  const years = Math.floor(experienceMonths(profile, today) / 12);
  const focus = profile.skills.slice(0, MAX_FOCUS).map((skill) => skill.name.trim()).filter(Boolean);
  const languages = profile.languages.map((language) => {
    const course = /^(german|deutsch)/i.test(language.name) && answers.germanCourse.trim() ? `, ${answers.germanCourse.trim()}` : "";
    return `${inGerman(language.name)}: ${labels.levels[language.level]}${course}`;
  });
  const availability = [answers.startDate.trim() ? `ab ${startText(answers.startDate)}` : "", answers.noticePeriod.trim() ? `Kündigungsfrist: ${answers.noticePeriod.trim()}` : ""].filter(Boolean).join(" · ");
  const city = [profile.basics.city.trim(), inGerman(profile.basics.country)].filter(Boolean).join(", ");

  const facts: [string, string][] = [
    ["Berufserfahrung", years > 0 ? `${years} Jahre` : ""],
    ["Schwerpunkte", focus.join(" · ")],
    ["Sprachen", languages.join(" · ")],
    ["Verfügbarkeit", availability],
    ["Gehaltsvorstellung", salaryText(answers.salary)],
    ["Arbeitserlaubnis", permitClaimed(answers) ? "Ja, ohne Visum oder Sponsoring" : ""],
    ["Wohnort", city],
    ["Einsatzort", answers.mobility.trim()],
    ["Abschluss anerkannt", answers.degreeRecognition.trim()],
  ];

  return {
    name: profile.basics.name.trim(),
    headline: profile.basics.headline.trim(),
    contact: [profile.basics.email, profile.basics.phone, city].map((item) => item.trim()).filter(Boolean),
    facts: facts.filter(([, value]) => value),
    roles: paidRoles(profile.experience)
      .slice(0, MAX_ROLES)
      .map((role) => ({ title: role.role.trim(), company: [role.company.trim(), role.location.trim()].filter(Boolean).join(", "), dates: formatDateRange(role, options) })),
    education: profile.education.map((entry) => ({ degree: entry.degree.trim(), school: entry.school.trim(), dates: formatDateRange(entry, options) })),
  };
}
