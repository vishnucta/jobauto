import { describe, expect, it } from "vitest";

import { demoProfile } from "@/lib/demo-profile";

import { tailoredProfile } from "./resume-fit";

describe("tailoredProfile (#370)", () => {
  const profile = demoProfile();

  it("reads the resume as a profile: only what it has, with its own text", () => {
    const [kept] = profile.experience;
    const tailored = tailoredProfile(profile, [
      { id: "summary", label: "Summary", text: "Payments designer." },
      { id: `experience:${kept.id}`, label: "Role", text: "Shipped payouts" },
      { id: "skills", label: "Skills", text: "Figma" },
    ]);
    expect(tailored.basics.summary).toBe("Payments designer.");
    expect(tailored.experience.map((entry) => [entry.id, entry.bullets])).toEqual([[kept.id, "Shipped payouts"]]);
    expect(tailored.projects).toEqual([]);
    expect(tailored.education).toEqual([]);
    expect(tailored.skills.map((skill) => skill.name)).toEqual(["Figma"]);
    // Facts never go on a resume, so they don't count for it.
    expect(tailored.facts).toEqual([]);
    // Who the candidate is stays.
    expect(tailored.basics.name).toBe(profile.basics.name);
  });

  it("keeps every skill when the resume has no skills part", () => {
    expect(tailoredProfile(profile, []).skills).toEqual(profile.skills);
  });
});
