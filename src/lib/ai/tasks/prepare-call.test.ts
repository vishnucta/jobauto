import { describe, expect, it } from "vitest";

import { demoProfile } from "@/lib/demo-profile";

import { MockProvider } from "../providers/mock";

import { prepareCall, type TaskOptions } from "./index";

const options: TaskOptions = { creativity: "BALANCED", strict: true, language: null };
const profile = demoProfile();
const input = { profile, extracted: null, posting: "Product Designer (m/w/d) bei Northwind in Hamburg.", company: "Northwind", role: "Product Designer", german: "B1", facts: [] };

const answer = {
  questions: [
    { question: { de: " Erzählen Sie etwas über sich. ", en: "Tell me about yourself." }, answer: { de: " Ich bin Designerin. ", en: "I'm a designer." } },
    { question: { de: "", en: "Empty" }, answer: { de: "", en: "" } },
  ],
  salary: { de: "Ich stelle mir […] Euro vor.", en: "I'm thinking of […] euros." },
  stories: [{ title: " Redesign ", situation: "s", action: "a", result: "r" }, { title: " ", situation: "", action: "", result: "" }],
  toAsk: [{ de: "Wie groß ist das Team?", en: "How big is the team?" }],
  gaps: [" What is your notice period? ", ""],
};

describe("prepareCall (Phase 3)", () => {
  it("asks for German at the candidate's level and keeps what was written, tidied", async () => {
    const provider = new MockProvider({ reply: () => answer });
    const { data, promptVersion } = await prepareCall(provider, input, options);
    expect(promptVersion).toBe("prepare-call@1");
    expect(data.questions).toEqual([{ question: { de: "Erzählen Sie etwas über sich.", en: "Tell me about yourself." }, answer: { de: "Ich bin Designerin.", en: "I'm a designer." } }]);
    expect(data.stories.map((story) => story.title)).toEqual(["Redesign"]);
    expect(data.gaps).toEqual(["What is your notice period?"]);
    const [call] = provider.calls;
    expect(call.system).toContain("The candidate's German: B1.");
    expect(call.system).toContain("Never name a figure");
    expect(call.messages[0].content).toContain("The job: Product Designer at Northwind");
    expect(call.messages[0].content).toContain("Northwind in Hamburg");
  });

  it("flags what the answers claim that the profile doesn't back, in strict mode", async () => {
    const provider = new MockProvider({
      reply: () => ({ ...answer, questions: [{ question: answer.questions[0].question, answer: { de: "Ich habe 25 Jahre bei Initech gearbeitet.", en: "I worked at Initech for 25 years." } }] }),
    });
    const { data } = await prepareCall(provider, input, options);
    expect(data.unverified.length).toBeGreaterThan(0);
    const loose = await prepareCall(provider, input, { ...options, strict: false });
    expect(loose.data.unverified).toEqual([]);
  });
});
