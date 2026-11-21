import "server-only";

import { seenPostings } from "@/lib/seen-postings";

import { salaryGuide, type SalaryGuide } from "./salary-guide";

/** Every job Dossier has seen with a salary stated, each once (seen-postings.ts). */
export async function postingsWithSalary(): Promise<{ title: string; salary: string }[]> {
  return (await seenPostings()).postings.filter((posting) => posting.salary.trim()).map(({ title, salary }) => ({ title, salary }));
}

/** The salary guide for a job title, from everything seen; null when too few postings state a salary. */
export async function loadSalaryGuide(title: string): Promise<SalaryGuide | null> {
  return title.trim() ? salaryGuide(title, await postingsWithSalary()) : null;
}
