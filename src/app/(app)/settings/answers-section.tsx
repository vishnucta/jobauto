"use client";

import { useState } from "react";

import { useTrackSave } from "@/components/save-tracker";
import { toastResult } from "@/components/toast";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Toggle } from "@/components/ui/toggle";
import { LANGUAGE_LEVEL_ANSWERS, type ApplyAnswers } from "@/lib/apply/answers";

import { saveStandardAnswers } from "./answers-actions";
import { SettingsSectionIntro } from "./settings-screen";

/** "€54,000–€59,000 a year (middle €58,000), from 12 jobs like “Financial Analyst”": what postings she has seen pay, for the profile's own title. */
export type SalaryHint = { title: string; text: string };

/** A level as forms ask it. */
const levelName = (level: (typeof LANGUAGE_LEVEL_ANSWERS)[number]) => (level === "native" ? "Native" : level);

/**
 * Settings → Standard answers (jobauto fork): the answers German forms ask
 * for and the profile doesn't hold, edited here only and used for every
 * application: the apply assistant's forms, the letter, call prep, the
 * Kurzprofil and agencies' messages. The salary guide sits by the salary.
 * Each application's Apply tab shows them, read-only, with a link here.
 */
export function AnswersSection({ initial, salaryGuide }: { initial: ApplyAnswers; salaryGuide: SalaryHint | null }) {
  const track = useTrackSave();
  const [saved, setSaved] = useState(initial);
  const [answers, setAnswers] = useState(initial);
  const [saving, setSaving] = useState(false);
  const set = <K extends keyof ApplyAnswers>(key: K, value: ApplyAnswers[K]) => setAnswers((current) => ({ ...current, [key]: value }));
  const dirty = JSON.stringify(answers) !== JSON.stringify(saved);

  const save = async () => {
    setSaving(true);
    const result = toastResult(await track(saveStandardAnswers({ answers })));
    setSaving(false);
    if (!result.ok) return;
    // Saved once, they're hers (permitClaimed).
    const kept = { ...answers, confirmed: true };
    setSaved(kept);
    setAnswers(kept);
  };

  return (
    <>
      <SettingsSectionIntro title="Standard answers">
        Used for every application. What German forms ask for and your profile doesn&apos;t hold: the apply assistant fills them into forms, the cover letter states your
        salary and start date when a posting asks, call prep answers with them, and agencies get them in your Kurzprofil. Leave one empty and it&apos;s left to you: nothing
        is made up in its place.
      </SettingsSectionIntro>
      <Card className="@container flex flex-col gap-4">
        <div className="grid gap-4 @min-[560px]:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Input label="Salary expectation" placeholder="e.g. 55.000 € brutto/Jahr" value={answers.salary} onChange={(event) => set("salary", event.target.value)} />
            {/* The salary guide by the salary (jobauto fork): what postings she has seen pay. */}
            <p className="text-meta text-pretty text-muted">
              {salaryGuide
                ? `Postings you've seen: ${salaryGuide.text}.`
                : "Postings you've seen don't state enough salaries for a guide yet. Each application's Apply tab shows one for its job once they do."}
            </p>
          </div>
          <Input label="Earliest start date" hint="“sofort”, or a day as YYYY-MM-DD" placeholder="sofort" value={answers.startDate} onChange={(event) => set("startDate", event.target.value)} />
          <Input label="Notice period" placeholder="e.g. keine, or 3 Monate" value={answers.noticePeriod} onChange={(event) => set("noticePeriod", event.target.value)} />
          <Input
            label="German course"
            hint="What you're doing to improve, and the exam date"
            placeholder="e.g. B1 course since Sept 2026, exam March 2027"
            value={answers.germanCourse}
            onChange={(event) => set("germanCourse", event.target.value)}
          />
          <Input label="Where you'd work" hint="For agencies and your Kurzprofil" placeholder="e.g. Ganz Deutschland, auch remote" value={answers.mobility} onChange={(event) => set("mobility", event.target.value)} />
          <Input
            label="Degree recognition"
            hint="Your degree's German equivalence, if assessed"
            placeholder="e.g. ZAB: equivalent to a German Bachelor"
            value={answers.degreeRecognition}
            onChange={(event) => set("degreeRecognition", event.target.value)}
          />
          <Select label="German level" value={answers.germanLevel} onChange={(event) => set("germanLevel", event.target.value as ApplyAnswers["germanLevel"])}>
            {LANGUAGE_LEVEL_ANSWERS.map((level) => (
              <option key={level} value={level}>
                {levelName(level)}
              </option>
            ))}
          </Select>
          <Select label="English level" value={answers.englishLevel} onChange={(event) => set("englishLevel", event.target.value as ApplyAnswers["englishLevel"])}>
            {LANGUAGE_LEVEL_ANSWERS.map((level) => (
              <option key={level} value={level}>
                {levelName(level)}
              </option>
            ))}
          </Select>
          <Checkbox className="self-end" label="I'm allowed to work in Germany without sponsorship" checked={answers.workPermit} onChange={(event) => set("workPermit", event.target.checked)} />
        </div>
        <Toggle
          label="Press Send for me"
          description="Only on systems whose forms are simple and stable (Personio, Greenhouse, Lever, JOIN and a few more), only when nothing is left for you to fill, and never past a CAPTCHA. Everywhere else you press Send yourself."
          checked={answers.autoSubmit}
          onCheckedChange={(checked) => set("autoSubmit", checked)}
        />
        <div className="flex items-center gap-3">
          <Button variant={dirty ? "primary" : "secondary"} aria-disabled={saving || !dirty || undefined} onClick={() => !saving && dirty && void save()}>
            {saving ? "Saving…" : "Save answers"}
          </Button>
          {dirty && <span className="text-meta text-muted">Not saved yet</span>}
          {!dirty && !saved.confirmed && <span className="text-meta text-muted">Not saved yet: until you save them, letters don&apos;t claim a work permit.</span>}
        </div>
      </Card>
    </>
  );
}
