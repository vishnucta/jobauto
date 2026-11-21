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
    expect(promptVersion).toBe("prepare-call@2");
    expect(data.questions).toEqual([{ question: { de: "Erzählen Sie etwas über sich.", en: "Tell me about yourself." }, answer: { de: "Ich bin Designerin.", en: "I'm a designer." } }]);
    expect(data.stories.map((story) => story.title)).toEqual(["Redesign"]);
    // Nothing saved: each standard answer is one to fill in, and the model's question about one of them goes.
    expect(data.gaps).toEqual([
      "Your earliest start date isn't in your standard answers. Fill it in under Settings → Standard answers, then prepare again.",
      "Your notice period isn't in your standard answers. Fill it in under Settings → Standard answers, then prepare again.",
      "Your salary expectation isn't in your standard answers. Fill it in under Settings → Standard answers, then prepare again.",
      "Your work permit isn't in your standard answers. Fill it in under Settings → Standard answers, then prepare again.",
    ]);
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

  it("quotes the whole sentence a flag is in, not the bare word (jobauto fork)", async () => {
    const provider = new MockProvider({
      reply: () => ({ ...answer, questions: [{ question: answer.questions[0].question, answer: { de: "…", en: "I am a designer. I worked at Initech for 25 years." } }] }),
    });
    const { data } = await prepareCall(provider, input, options);
    expect(data.unverified).toEqual(["I worked at Initech for 25 years."]);
  });

  it("points out how long she's learned German when nothing she saved says, even when not strict (jobauto fork)", async () => {
    const provider = new MockProvider({
      reply: () => ({ ...answer, questions: [{ question: answer.questions[0].question, answer: { de: "Ich lerne Deutsch seit einem Jahr.", en: "I have been learning German for a year." } }] }),
    });
    const { data } = await prepareCall(provider, input, { ...options, strict: false });
    expect(data.unverified).toEqual(["I have been learning German for a year."]);
    expect(provider.calls[0].system).toContain("Without a German course, say nothing about how long they have been learning German.");
  });

  it("uses her standard answers and never makes them up (jobauto fork)", async () => {
    const answers = { startDate: "sofort", noticePeriod: "keine", salary: "55.000 € brutto/Jahr", workPermit: true, germanCourse: "B1 course, exam March 2027" };
    const provider = new MockProvider({
      reply: () => ({
        ...answer,
        questions: [{ question: { de: "Wann können Sie anfangen?", en: "When can you start?" }, answer: { de: "Ich kann sofort anfangen. Ich habe keine Kündigungsfrist.", en: "I can start right away. I have no notice period." } }],
        gaps: ["What is your notice period?", "What salary will you ask for?", "Do you have a work permit?", "Who will you report to?"],
      }),
    });
    const { data } = await prepareCall(provider, { ...input, answers }, options);
    const content = provider.calls[0].messages[0].content;
    expect(content).toContain("The candidate's standard answers, used for every application:\n- Earliest start date: sofort\n- Notice period: keine\n- Salary expectation: 55.000 € brutto/Jahr\n- Work permit: may work in Germany without a visa or sponsorship\n- German course: B1 course, exam March 2027");
    expect(content).not.toContain("Not saved yet");
    expect(provider.calls[0].system).toContain("Never give any other start date, notice period, salary, permit status or length of study");
    // The salary line is hers, written in code; the gaps her answers settle go.
    expect(data.salary).toEqual({ de: "Meine Gehaltsvorstellung liegt bei 55.000 € brutto/Jahr.", en: "My salary expectation is 55.000 € brutto/Jahr." });
    expect(data.gaps).toEqual(["Who will you report to?"]);
    // What she saved isn't flagged as made up.
    expect(data.unverified).toEqual([]);

    // Only the notice period missing: the prompt says to leave it as "[…]", and she's told to fill it in.
    const some = new MockProvider({ reply: () => answer });
    const partial = await prepareCall(some, { ...input, answers: { ...answers, noticePeriod: "", workPermit: null } }, options);
    expect(some.calls[0].messages[0].content).toContain('Not saved yet, so write "[…]" wherever an answer needs one, never a made-up value: notice period, work permit.');
    expect(partial.data.gaps).toEqual([
      "Your notice period isn't in your standard answers. Fill it in under Settings → Standard answers, then prepare again.",
      "Your work permit isn't in your standard answers. Fill it in under Settings → Standard answers, then prepare again.",
    ]);
  });
});
