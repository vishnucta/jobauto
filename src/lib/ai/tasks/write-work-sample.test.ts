import { describe, expect, it } from "vitest";

import { demoProfile } from "@/lib/demo-profile";

import { MockProvider } from "../providers/mock";

import { writeWorkSample, type TaskOptions } from "./index";

const options: TaskOptions = { creativity: "BALANCED", strict: true, language: "German" };
const input = { profile: demoProfile(), extracted: null, posting: "Product Designer (m/w/d) bei Northwind in Hamburg.", company: "Northwind", role: "Product Designer", facts: [] };

const answer = {
  title: " Meine ersten 90 Tage als Product Designer bei Northwind ",
  situation: "Wie ich die Anzeige lese, braucht das Team ein Designsystem.",
  phases: [
    { heading: "Tage 1–30: Verstehen", steps: [" Interviews mit dem Team ", ""] },
    { heading: "Tage 31–60: Aufbauen", steps: ["Komponenten bauen"] },
    { heading: "Tage 61–90: Liefern", steps: ["Erstes Release"] },
    { heading: "Extra", steps: ["Too many"] },
    { heading: " ", steps: [] },
  ],
  proof: [" Bei Ledgerly habe ich ein Designsystem aufgebaut. "],
  closing: "Ich freue mich, den Plan mit Ihnen zu besprechen.",
};

describe("writeWorkSample (jobauto fork)", () => {
  it("writes three phases in the documents' language, tidied, from the posting and the profile", async () => {
    const provider = new MockProvider({ reply: () => answer });
    const { data, promptVersion } = await writeWorkSample(provider, input, options);
    expect(promptVersion).toBe("write-work-sample@1");
    expect(data.title).toBe("Meine ersten 90 Tage als Product Designer bei Northwind");
    expect(data.phases).toEqual([
      { heading: "Tage 1–30: Verstehen", steps: ["Interviews mit dem Team"] },
      { heading: "Tage 31–60: Aufbauen", steps: ["Komponenten bauen"] },
      { heading: "Tage 61–90: Liefern", steps: ["Erstes Release"] },
    ]);
    const [call] = provider.calls;
    expect(call.system).toContain("My first 90 days");
    expect(call.system).toContain("German");
    expect(call.messages[0].content).toContain("The job: Product Designer at Northwind");
  });

  it("flags what the proof claims that the profile doesn't back, only in strict mode", async () => {
    const provider = new MockProvider({ reply: () => ({ ...answer, proof: ["At Initech I led 40 people for 25 years."] }) });
    expect((await writeWorkSample(provider, input, options)).data.unverified.length).toBeGreaterThan(0);
    expect((await writeWorkSample(provider, input, { ...options, strict: false })).data.unverified).toEqual([]);
  });
});
