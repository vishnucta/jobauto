"use client";

import { useMemo } from "react";

import { toast, toastResult } from "@/components/toast";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { useAutosave } from "@/hooks/use-autosave";
import { formatDateRange, type EntryOrder, type ExperienceItem, type ProfileData } from "@/lib/profile";

import {
  attachNewSkill,
  createExperience,
  removeExperience,
  reorderEntries,
  restoreExperience,
  saveExperience,
  setExperienceSkill,
  setRoleVolunteering,
  sortEntriesByDate,
} from "./actions";
import { BulletsField } from "./bullets-field";
import { EntryList } from "./entry-list";
import { MonthYearField } from "./month-year-field";
import { useTrackSave } from "@/components/save-tracker";
import type { UpdateProfile } from "./skills-section";
import { SkillsUsed } from "./skills-used";

/** The fields of an open role, autosaved as you type. */
function ExperienceForm({
  entry,
  onChange,
  autoFocus,
}: {
  entry: ExperienceItem;
  onChange: (entry: ExperienceItem) => void;
  autoFocus: boolean;
}) {
  const track = useTrackSave();
  // Autosave the text and dates only; skill links save on their own when toggled.
  const { id, role, company, location, descriptor, bullets, startYear, startMonth, endYear, endMonth, current } = entry;
  const fields = useMemo(
    () => ({ id, role, company, location, descriptor, bullets, startYear, startMonth, endYear, endMonth, current }),
    [id, role, company, location, descriptor, bullets, startYear, startMonth, endYear, endMonth, current],
  );
  const { flush } = useAutosave(fields, (value) => track(saveExperience(value)));
  const set = (change: Partial<ExperienceItem>) => onChange({ ...entry, ...change });

  return (
    <div className="grid grid-cols-2 gap-[18px]" onBlur={flush}>
      <Input
        className="col-span-2"
        label="Role"
        placeholder="Product Designer"
        value={entry.role}
        onChange={(event) => set({ role: event.target.value })}
        autoFocus={autoFocus}
      />
      <Input
        label={entry.volunteering ? "Organisation" : "Company"}
        placeholder={entry.volunteering ? "Food Bank Springfield" : "Acme Inc."}
        value={entry.company}
        onChange={(event) => set({ company: event.target.value })}
      />
      <Input
        label="Location"
        placeholder="Springfield"
        value={entry.location}
        onChange={(event) => set({ location: event.target.value })}
      />
      <Input
        className="col-span-2"
        label="About the company or role"
        placeholder="A 40-person fintech, building card payments"
        hint="Optional. One line, in italics under the role on your resume."
        maxLength={300}
        value={entry.descriptor}
        onChange={(event) => set({ descriptor: event.target.value })}
      />
      <MonthYearField
        label="Started"
        value={{ month: entry.startMonth, year: entry.startYear }}
        onChange={({ month, year }) => set({ startMonth: month, startYear: year })}
      />
      <div className="flex flex-col gap-2.5">
        <MonthYearField
          label="Ended"
          value={{ month: entry.endMonth, year: entry.endYear }}
          onChange={({ month, year }) => set({ endMonth: month, endYear: year })}
          disabled={entry.current}
        />
        <Checkbox
          label={entry.volunteering ? "I still volunteer here" : "I still work here"}
          checked={entry.current}
          onChange={(event) => set({ current: event.target.checked })}
        />
      </div>
      <BulletsField placeholder="One point per line. Rough is fine." value={entry.bullets} onChange={(bullets) => set({ bullets })} />
    </div>
  );
}

const roleTitle = (entry: ExperienceItem) => entry.role.trim() || "New role";

/**
 * Work experience (PRO-5) or Volunteering (#294), which resumes print under
 * their own headings: one card open at a time, autosaved, with Undo on Remove.
 * Both are roles in one table, so the order saved keeps the other list's roles.
 */
export function ExperienceSection({
  profile,
  update,
  order,
  volunteering = false,
}: {
  profile: ProfileData;
  update: UpdateProfile;
  order: EntryOrder;
  volunteering?: boolean;
}) {
  const track = useTrackSave();
  const items = profile.experience.filter((entry) => entry.volunteering === volunteering);
  const others = profile.experience.filter((entry) => entry.volunteering !== volunteering);
  const skillNames = (entry: ExperienceItem) =>
    profile.skills.filter((skill) => entry.skillIds.includes(skill.id)).map((skill) => skill.name);

  const moveAcross = async (entry: ExperienceItem) => {
    const result = toastResult(await track(setRoleVolunteering({ id: entry.id, volunteering: !volunteering })));
    if (!result.ok) return;
    update((current) => ({ ...current, experience: current.experience.map((item) => (item.id === entry.id ? { ...item, volunteering: !volunteering } : item)) }));
    toast(`Moved “${roleTitle(entry)}” to ${volunteering ? "Experience" : "Volunteering"}.`);
  };

  return (
    <EntryList
      items={items}
      setItems={(change) =>
        update((current) => {
          const isHere = (entry: ExperienceItem) => entry.volunteering === volunteering;
          return { ...current, experience: [...change(current.experience.filter(isHere)), ...current.experience.filter((entry) => !isHere(entry))] };
        })
      }
      addLabel={volunteering ? "Add volunteering" : "Add a role"}
      ordering={{
        mode: order,
        save: (ids) => reorderEntries({ section: "experience", ids: [...ids, ...others.map((entry) => entry.id)] }),
        sortByDate: () => sortEntriesByDate({ section: "experience" }),
      }}
      summary={(entry) => ({
        title: roleTitle(entry),
        subtitle: [entry.company, entry.location].filter((part) => part.trim()).join(" · "),
        meta: formatDateRange(entry),
        footnote: skillNames(entry).join(" · ") || undefined,
      })}
      create={() => createExperience({ volunteering })}
      remove={(entry) => removeExperience({ id: entry.id })}
      restore={(entry) => restoreExperience(entry)}
      renderForm={(entry, { onChange, autoFocus }) => (
        <>
          <ExperienceForm entry={entry} onChange={onChange} autoFocus={autoFocus} />
          <SkillsUsed
            entry={entry}
            noun="role"
            skills={profile.skills}
            update={update}
            setLinks={(change) =>
              update((current) => ({
                ...current,
                experience: current.experience.map((item) => (item.id === entry.id ? { ...item, skillIds: change(item.skillIds) } : item)),
              }))
            }
            attach={(skillId, attached) => setExperienceSkill({ experienceId: entry.id, skillId, attached })}
            attachNew={(name) => attachNewSkill({ experienceId: entry.id, name })}
          />
          <Button variant="text" size="sm" className="self-start" onClick={() => void moveAcross(entry)}>
            Move to {volunteering ? "Experience" : "Volunteering"}
          </Button>
        </>
      )}
    />
  );
}
