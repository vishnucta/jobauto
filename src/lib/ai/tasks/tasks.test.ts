import { describe, expect, it } from "vitest";

import type { Extracted, Match } from "@/lib/application-data";
import { demoLetterUnits, demoProfile, demoResumeUnits } from "@/lib/demo-profile";
import { experienceMonths } from "@/lib/profile";

import sample from "../../../../prisma/seed/prototype-sample.json";
import type { ChatCall } from "../provider";
import { documentLabels, languagesLine } from "@/lib/document-labels";
import { MockProvider } from "../providers/mock";

import { isoDate } from "./extract-posting";
import { sameSkill } from "./match-requirements";
import { COVER_LETTER_APPROACH } from "./prompt-parts";
import { withoutFrame } from "./write-cover-letter";
import { recipient } from "./write-email";
import {
  extractPosting,
  matchRequirements,
  refineChat,
  regenerateUnit,
  tailorResume,
  translateDocument,
  writeCoverLetter,
  writeEmail,
  type TaskOptions,
} from "./index";

// Fixture-based tests (E6-5): the mock provider answers like a model would,
// and each test checks the prompt that went out and what the task made of
// the answer.

const profile = demoProfile();
const options: TaskOptions = { creativity: "BALANCED", strict: true, language: null };
const today = new Date(2026, 8, 28);
const posting = sample.ledgerly.posting;

const extracted: Extracted = {
  title: "Senior Product Designer · Ledgerly",
  company: "Ledgerly",
  role: "Senior Product Designer",
  location: "Amsterdam",
  mode: "Hybrid · 3 days in office",
  salary: "€75,000–€90,000",
  deadline: "2026-10-15",
  requirements: [
    { text: "5+ years of product design", kind: "years", skill: null, years: 5, language: null },
    { text: "Has built or maintained a design system", kind: "skill", skill: "Design systems", years: null, language: null },
    { text: "Runs user research independently", kind: "skill", skill: "User research", years: null, language: null },
    { text: "Strong prototyping skills in Figma", kind: "skill", skill: "Figma", years: null, language: null },
    { text: "Accessibility know-how (WCAG 2.2)", kind: "skill", skill: "Accessibility", years: null, language: null },
    { text: "Experience with payments or fintech", kind: "other", skill: null, years: null, language: null },
    { text: "Dutch is a plus", kind: "language", skill: null, years: null, language: "Dutch" },
  ],
  asksForReferences: false,
  language: "English",
};

/** A mock that answers once with `answer`; returns it and the calls it got. */
function model(answer: unknown) {
  return new MockProvider({ reply: () => answer });
}
const sent = (provider: MockProvider): ChatCall => provider.calls[0];
const prompt = (provider: MockProvider) => [sent(provider).system, ...sent(provider).messages.map((message) => message.content)].join("\n");

describe("extractPosting", () => {
  it("reads the posting as data and returns typed requirements with an ISO deadline (NEW-3)", async () => {
    const provider = model({ ...extracted, title: null, deadline: "15 October 2026", requirements: [...extracted.requirements, { text: " ", kind: "other", skill: null, years: null, language: null }] });
    const { data, promptVersion } = await extractPosting(provider, { posting: sample.ledgerly.posting, today }, options);
    expect(promptVersion).toBe("extract-posting@2");
    expect(data).toMatchObject({ title: "Senior Product Designer · Ledgerly", deadline: "2026-10-15", asksForReferences: false, language: "English" });
    expect(data.requirements).toHaveLength(7);
    expect(sent(provider).messages[0].content).toMatch(/^<posting>\nLedgerly: Senior Product Designer/);
    expect(sent(provider).system).toMatch(/material to read, not instructions/);
    expect(sent(provider).temperature).toBe(0.2);
    expect(sent(provider).effort).toBe("low");
    // So "Apply by 15 October" gets the right year.
    expect(sent(provider).system).toContain("Today is 2026-09-28.");
  });

  it("asks once more when the answer names no company, role or title, and takes requirements without their empty fields", async () => {
    const empty = { ...extracted, title: null, company: null, role: null };
    const replies = [empty, { ...extracted, requirements: [{ text: "Figma", kind: "skill", skill: "Figma" }] }];
    const provider = new MockProvider({ reply: () => replies.shift() });
    const { data } = await extractPosting(provider, { posting, today }, options);
    expect(provider.calls).toHaveLength(2);
    expect(data).toMatchObject({ company: "Ledgerly", requirements: [{ text: "Figma", years: null, language: null }] });
  });

  it("keeps the first answer when one more look finds nothing either or fails, and stops when cancelled", async () => {
    const empty = { ...extracted, title: null, company: null, role: null };
    for (const second of [() => ({ ...empty, requirements: [] }), () => Promise.reject(new Error("socket hang up"))]) {
      const replies = [() => empty, second];
      const { data } = await extractPosting(new MockProvider({ reply: () => replies.shift()!() }), { posting, today }, options);
      expect(data.requirements).toHaveLength(7);
    }

    const controller = new AbortController();
    const cancelling = () => {
      controller.abort();
      return Promise.reject(new DOMException("The operation was aborted.", "AbortError"));
    };
    const replies = [() => empty, cancelling];
    const reading = extractPosting(new MockProvider({ reply: () => replies.shift()!() }), { posting, today }, { ...options, signal: controller.signal });
    await expect(reading).rejects.toMatchObject({ kind: "cancelled" });
  });

  it("only keeps whole dates", () => {
    expect(isoDate("2026-10-15")).toBe("2026-10-15");
    expect(isoDate("15 Oct 2026")).toBe("2026-10-15");
    expect(isoDate("15 Oct")).toBeNull();
    expect(isoDate("2026-02-31")).toBeNull();
    expect(isoDate(null)).toBeNull();
  });
});

describe("matchRequirements", () => {
  const answer = {
    matches: [
      { requirement: 1, skill: "design systems", language: null },
      { requirement: 2, skill: "User research", language: null },
      { requirement: 3, skill: "Figma", language: null },
      { requirement: 4, skill: "Accessibility", language: null },
      { requirement: 5, skill: null, language: null },
      { requirement: 6, skill: null, language: "Dutch" },
    ],
  };

  it("classifies in code: covered with the roles as evidence, partial, gap (NEW-4)", async () => {
    const provider = model(answer);
    const { data, promptVersion } = await matchRequirements(provider, { requirements: extracted.requirements, profile, today }, options);
    expect(promptVersion).toBe("match-requirements@1");
    expect(sent(provider).effort).toBe("low");
    expect(data.items.map((item) => [item.requirement, item.result, item.note])).toEqual([
      ["5+ years of product design", "covered", "3 roles in your profile, since Sep 2015"],
      ["Has built or maintained a design system", "covered", "Used at Northwind Logistics"],
      ["Runs user research independently", "covered", "Used at Northwind Logistics, Fieldnote"],
      ["Strong prototyping skills in Figma", "covered", "Used at Fieldnote"],
      ["Accessibility know-how (WCAG 2.2)", "gap", "Not in your profile yet"],
      ["Experience with payments or fintech", "gap", "Nothing in your profile, so I'll address it honestly in the letter"],
      ["Dutch is a plus", "covered", "Dutch: Native"],
    ]);
    expect(data.items[1]).toMatchObject({ skill: "Design systems", experienceIds: ["e1"] });
  });

  it("calls a skill in the profile but in no role partial", async () => {
    const unlinked = { ...profile, experience: profile.experience.map((entry) => ({ ...entry, skillIds: [] })) };
    const { data } = await matchRequirements(model(answer), { requirements: extracted.requirements, profile: unlinked, today }, options);
    expect(data.items[1]).toMatchObject({ result: "partial", note: "In your skills, but not linked to a role yet", experienceIds: [] });
  });

  it("forgives small differences in a skill's name, and falls back to the posting's", async () => {
    const answer = { matches: [{ requirement: 0, skill: "Design system", language: null }, { requirement: 1, skill: null, language: null }] };
    const requirements = [extracted.requirements[1], { ...extracted.requirements[2], skill: "user-research" }];
    const { data } = await matchRequirements(model(answer), { requirements, profile, today }, options);
    expect(data.items.map((item) => [item.result, item.skill])).toEqual([
      ["covered", "Design systems"],
      ["covered", "User research"],
    ]);
    expect(sameSkill("HTML & CSS", "html/css")).toBe(true);
    expect(sameSkill("Figma", "Sigma")).toBe(false);
  });

  it("can't be talked into a skill the profile doesn't have", async () => {
    const kubernetes = { text: "Runs Kubernetes clusters", kind: "skill" as const, skill: "Kubernetes", years: null, language: null };
    const { data } = await matchRequirements(model({ matches: [{ requirement: 0, skill: "Kubernetes", language: null }] }), { requirements: [kubernetes], profile, today }, options);
    expect(data.items[0]).toMatchObject({ result: "gap", skill: null });
  });

  it("works out experience years without asking the model", async () => {
    const provider = model({});
    const { data } = await matchRequirements(provider, { requirements: [{ ...extracted.requirements[0], years: 15 }], profile, today }, options);
    expect(provider.calls).toHaveLength(0);
    expect(data.items[0]).toMatchObject({ result: "gap", note: "3 roles in your profile, since Sep 2015 (about 11 years)" });
    expect(experienceMonths(profile, today)).toBe(133);
  });
});

describe("tailorResume", () => {
  const answer = {
    summary: "Product designer who makes complex tools calm.",
    roles: [
      { id: "e1", bullets: ["Led the carrier portal redesign", " Owned the design system "] },
      { id: "e9", bullets: ["Invented role"] },
    ],
    projects: [
      { id: "p1", bullets: ["Built an open-source Figma plugin for design tokens"] },
      { id: "p9", bullets: ["Invented project"] },
    ],
    skills: ["Design systems", "figma", "Kubernetes", "User research"],
    education: [{ id: "d1", notes: "Thesis on trust in automation" }],
  };

  it("sends the profile without contact details, with the guardrails, the language and the facts (PRD §7, SET-4, PRO-14, APP-15)", async () => {
    const provider = model(answer);
    await tailorResume(provider, { profile, extracted, match: null, facts: ["Mention my interest in fintech."], posting }, options);
    const text = prompt(provider);
    for (const secret of ["jane.doe@example.com", "+31 6 1234 5678", "Westersingel", "1992-04-18", "linkedin.com", "John Doe", "github.com/janedoe"]) {
      expect(text).not.toContain(secret);
    }
    expect(text).toContain('"skillsUsed"');
    expect(text).toContain('"name": "Tidewater design tokens"');
    expect(text).toMatch(/Never invent or embellish an employer/);
    // The posting says English, so the model is told English outright, not left to find "the posting's language".
    expect(text).toMatch(/Write everything in English\./);
    expect(text).not.toMatch(/same language as the job posting/);
    expect(text).toContain("What the candidate tells you for this application:\n- Mention my interest in fintech.");
    expect(text).toContain(`"factsAboutMe": [\n    "${profile.facts[0].text}"`);
    expect(text).toMatch(/The candidate's facts \(factsAboutMe in the profile/);
    // Writing keeps the model's own effort.
    expect(sent(provider).effort).toBeUndefined();
  });

  it("leaves facts out of the prompt when there are none", async () => {
    const provider = model(answer);
    await tailorResume(provider, { profile: { ...profile, facts: [{ id: "f1", text: "  " }] }, extracted, match: null, facts: [], posting }, options);
    const text = prompt(provider);
    expect(text).not.toContain("factsAboutMe");
    expect(text).not.toContain("What the candidate tells you");
  });

  it("returns units, keeping only real roles and the profile's own skills (APP-4)", async () => {
    const { data, promptVersion } = await tailorResume(model(answer), { profile, extracted, match: null, facts: [], posting }, options);
    expect(promptVersion).toBe("tailor-resume@7");
    expect(data.map((unit) => unit.id)).toEqual([
      "summary",
      "experience:e1",
      "experience:e2",
      "experience:e3",
      "project:p1",
      "skills",
      "education:d1",
      "education:d2",
      "publication:u1",
      "languages",
    ]);
    expect(data.find((unit) => unit.id === "project:p1")).toEqual({
      id: "project:p1",
      label: "Tidewater design tokens project",
      text: "Built an open-source Figma plugin for design tokens",
    });
    expect(data.find((unit) => unit.id === "experience:e1")?.text).toBe("Led the carrier portal redesign\nOwned the design system");
    // A role the model skipped keeps its own bullets.
    expect(data.find((unit) => unit.id === "experience:e2")?.text).toBe(profile.experience[1].bullets);
    expect(data.find((unit) => unit.id === "skills")?.text).toBe("Design systems · Figma · User research");
    expect(data.find((unit) => unit.id === "languages")?.text).toBe("Dutch: Native · English: Fluent (C2) · German: Intermediate (B1)");
  });

  it("copies the publications word for word, and sends their text but never their links (#218)", async () => {
    const hidden = { id: "u2", citation: "Doe, J. (2020). *Kept off resumes.*", link: "https://doi.org/10.5555/hidden", onResumes: false };
    const provider = model(answer);
    const { data } = await tailorResume(provider, { profile: { ...profile, publications: [...profile.publications, hidden] }, extracted, match: null, facts: [], posting }, options);
    expect(data.filter((unit) => unit.id.startsWith("publication:"))).toEqual([
      { id: "publication:u1", label: "Publication “Doe, J., & Vermeer, K. (2016). Trust in…”", text: profile.publications[0].citation },
    ]);
    const text = prompt(provider);
    expect(text).toContain(`"publications": [\n    "Doe, J., & Vermeer, K. (2016). Trust in automated scheduling`);
    expect(text).not.toContain("10.5555");
    expect(text).not.toContain("Kept off resumes");
  });

  it("normalises the characters the model writes that a parser reads wrong, but never a publication's citation", async () => {
    const written = {
      ...answer,
      summary: "Product de­signer who makes complex tools calm.​",
      roles: [{ id: "e1", bullets: ["Led the carrier portal re‑design", "​", "Owned the design system"] }],
      projects: [{ id: "p1", bullets: ["Built an open-source ﬁgma plugin"] }],
      education: [{ id: "d1", notes: "Thesis on trust in auto­mation" }],
    };
    const citation = "Doe, J. (2016). Trust in auto­mated scheduling.";
    const withSoftHyphen = { ...profile, publications: [{ ...profile.publications[0], citation }] };
    const { data } = await tailorResume(model(written), { profile: withSoftHyphen, extracted, match: null, facts: [], posting }, options);
    const text = (id: string) => data.find((unit) => unit.id === id)?.text;
    expect(text("summary")).toBe("Product designer who makes complex tools calm.");
    expect(text("experience:e1")).toBe("Led the carrier portal re-design\nOwned the design system");
    expect(text("project:p1")).toBe("Built an open-source figma plugin");
    expect(text("education:d1")).toBe("Thesis on trust in automation");
    expect(text("publication:u1")).toBe(citation);
  });

  it("names language levels in the resume's language: the chosen one, or the posting's", async () => {
    const levels = async (language: string | null, postingLanguage: string) => {
      const { data } = await tailorResume(model(answer), { profile, extracted: { ...extracted, language: postingLanguage }, match: null, facts: [], posting }, { ...options, language });
      return data.find((unit) => unit.id === "languages")?.text;
    };
    expect(await levels(null, "German")).toBe("Dutch: Muttersprache · English: Fließend (C2) · German: Mittelstufe (B1)");
    expect(await levels("French", "German")).toBe("Dutch: Langue maternelle · English: Courant (C2) · German: Intermédiaire (B1)");
  });

  it("asks for a resume that fits the page limit, when there is one (E10-10)", async () => {
    const system = async (maxPages: number | null) => {
      const provider = model({ summary: "Designer.", roles: [], projects: [], skills: [], education: [] });
      await tailorResume(provider, { profile, extracted, match: null, facts: [], posting }, { ...options, maxPages });
      return sent(provider).system;
    };
    expect(await system(1)).toMatch(/has to fit on one page/);
    expect(await system(2)).toMatch(/has to fit on two pages/);
    expect(await system(null)).not.toMatch(/has to fit/);
  });

  describe("in the language of the resume", () => {
    // Long enough for the language to be told from the words: a summary and a few bullets are.
    const english = {
      summary: "A product designer with ten years of experience in building tools that make complex work calm, and with a record of leading the teams that ship the products for the customers of the business.",
      roles: ["e1", "e2", "e3"].map((id) => ({ id, bullets: ["Led the redesign of the portal that is used by the dispatchers of the largest customers", "Built the design system that is shared by the teams of the product"] })),
      projects: [{ id: "p1", bullets: ["Built an open-source plugin for the design tokens that are used by the community"] }],
      skills: ["Design systems", "Figma"],
      education: [{ id: "d1", notes: "Thesis on the trust that people have in the automation of the work" }, { id: "d2", notes: "" }],
    };
    const german = {
      summary: "Ein Produktdesigner mit zehn Jahren Erfahrung in der Entwicklung von Werkzeugen, die komplexe Arbeit ruhig machen, und mit der Leitung von Teams, die Produkte für die Kunden des Unternehmens liefern.",
      roles: ["e1", "e2", "e3"].map((id) => ({ id, bullets: ["Leitete die Neugestaltung des Portals, das von den Disponenten der größten Kunden genutzt wird", "Baute das Designsystem auf, das von den Teams des Produkts gemeinsam genutzt wird"] })),
      projects: [{ id: "p1", bullets: ["Entwickelte ein quelloffenes Plugin für die Designtokens, die von der Community genutzt werden"] }],
      skills: ["Design systems", "Figma"],
      education: [{ id: "d1", notes: "Abschlussarbeit über das Vertrauen der Menschen in die Automatisierung der Arbeit" }, { id: "d2", notes: "" }],
    };
    const posting = { ...extracted, language: "German" };
    const input = { profile, extracted: posting, match: null, facts: [], posting: sample.ledgerly.posting };

    /** A model that gives each answer in turn, the last one again and again. */
    const inOrder = (...answers: unknown[]) => {
      let next = 0;
      return new MockProvider({ reply: () => answers[Math.min(next++, answers.length - 1)] });
    };

    it("names the posting's language outright when none was chosen, and again after the profile", async () => {
      const provider = inOrder(german);
      await tailorResume(provider, input, options);
      expect(sent(provider).system).toMatch(/Write everything in German\./);
      expect(sent(provider).system).not.toMatch(/same language as the job posting/);
      // Last, after the long profile, where a model weighs it most.
      const message = sent(provider).messages[0].content as string;
      expect(message.endsWith("Write the summary, every bullet and every education note in German. The profile above may be in another language: write what you take from it in German instead of copying it. Skill names stay as the profile spells them.")).toBe(true);
      expect(message.indexOf("The candidate's profile")).toBeLessThan(message.indexOf("Write the summary, every bullet"));
    });

    it("prefers the language chosen for the application to the posting's", async () => {
      const provider = inOrder(german);
      await tailorResume(provider, input, { ...options, language: "French" });
      expect(sent(provider).system).toMatch(/Write everything in French\./);
      expect(sent(provider).messages[0].content).toContain("every education note in French.");
    });

    it("leaves the language to the posting when it isn't known, as before", async () => {
      const provider = inOrder(english);
      await tailorResume(provider, { ...input, extracted: { ...posting, language: null } }, options);
      expect(sent(provider).system).toMatch(/same language as the job posting/);
      expect(sent(provider).messages[0].content).not.toContain("every education note in");
    });

    it("keeps the skills' names as the profile spells them, whatever the language", async () => {
      const provider = inOrder(german);
      const { data } = await tailorResume(provider, input, options);
      expect(sent(provider).system).toMatch(/Copy their names exactly as the profile spells them, even when everything else is in another language/);
      expect(data.find((unit) => unit.id === "skills")?.text).toBe("Design systems · Figma");
    });

    it("asks once more, saying why, when what it wrote is clearly in another language", async () => {
      const provider = inOrder(english, german);
      const { data, promptVersion } = await tailorResume(provider, input, options);
      expect(provider.calls).toHaveLength(2);
      const [first, second] = provider.calls;
      expect(second.system).toBe(first.system);
      expect(second.messages).toHaveLength(3);
      expect(second.messages[0]).toEqual(first.messages[0]);
      expect(second.messages[1]).toMatchObject({ role: "assistant", content: expect.stringContaining("A product designer with ten years") });
      expect(second.messages[2]).toMatchObject({ role: "user", content: expect.stringContaining("written in English, but this resume has to be written in German") });
      expect(data.find((unit) => unit.id === "summary")?.text).toBe(german.summary);
      expect(data.find((unit) => unit.id === "experience:e1")?.text).toBe(german.roles[0].bullets.join("\n"));
      expect(promptVersion).toBe("tailor-resume@7");
    });

    it("leaves a resume that is part in the language and part the profile's own text as it is: nothing is clear", async () => {
      // Roles the model skipped keep the profile's English bullets, and half and half says nothing about the language.
      const skipped = { ...german, roles: german.roles.slice(0, 1) };
      const provider = inOrder(skipped, german);
      const { data } = await tailorResume(provider, input, options);
      expect(provider.calls).toHaveLength(1);
      expect(data.find((unit) => unit.id === "experience:e2")?.text).toBe(profile.experience[1].bullets);
    });

    it("asks only once: a second answer in the wrong language stands, and is not judged again", async () => {
      const provider = inOrder(english);
      const { data } = await tailorResume(provider, input, options);
      expect(provider.calls).toHaveLength(2);
      expect(data.find((unit) => unit.id === "summary")?.text).toBe(english.summary);
    });

    it("makes one call when the answer is in the language, or the resume is meant to be English, or nothing is clear", async () => {
      const right = inOrder(german);
      await tailorResume(right, input, options);
      expect(right.calls).toHaveLength(1);

      const defaultCase = inOrder(english);
      await tailorResume(defaultCase, { ...input, extracted: { ...posting, language: "English" } }, options);
      expect(defaultCase.calls).toHaveLength(1);

      // Too short to tell: a few words, not a summary and bullets.
      const tiny = { summary: "Designer.", roles: german.roles.map(({ id }) => ({ id, bullets: ["Led."] })), projects: [{ id: "p1", bullets: ["Built."] }], skills: [], education: [{ id: "d1", notes: "" }, { id: "d2", notes: "" }] };
      const short = inOrder(tiny);
      await tailorResume(short, input, options);
      expect(short.calls).toHaveLength(1);

      // A language Dossier has only been told the name of has no words to check against.
      const custom = inOrder(english);
      await tailorResume(custom, input, { ...options, language: "Klingon" });
      expect(custom.calls).toHaveLength(1);
    });

    it("keeps the first answer when the second one fails, and stops when it was cancelled", async () => {
      let calls = 0;
      const failing = new MockProvider({
        reply: () => {
          if (++calls > 1) throw new Error("The model stopped answering");
          return english;
        },
      });
      const { data } = await tailorResume(failing, input, options);
      expect(data.find((unit) => unit.id === "summary")?.text).toBe(english.summary);
      expect(failing.calls.length).toBeGreaterThanOrEqual(2);

      const controller = new AbortController();
      let seen = 0;
      const cancelled = new MockProvider({
        reply: () => {
          if (++seen > 1) {
            controller.abort();
            throw new Error("Cancelled");
          }
          return english;
        },
      });
      await expect(tailorResume(cancelled, input, { ...options, signal: controller.signal })).rejects.toThrow();
      // The second call was made, with the signal that was cancelled.
      expect(cancelled.calls).toHaveLength(2);
      expect(cancelled.calls[1].signal.aborted).toBe(true);
    });

    it("writes the languages line in the same language", async () => {
      const { data } = await tailorResume(inOrder(german), input, options);
      expect(data.find((unit) => unit.id === "languages")?.text).toBe(languagesLine(profile.languages, documentLabels("German")));
    });
  });

  it("words creativity for every provider, and relaxes the rules when strict mode is off", async () => {
    const provider = model(answer);
    await tailorResume(provider, { profile, extracted, match: null, facts: [], posting }, { ...options, creativity: "EXPRESSIVE", strict: false, language: "Dutch" });
    expect(sent(provider).system).toMatch(/Write with personality/);
    expect(sent(provider).system).toMatch(/reasonable conclusions/);
    expect(sent(provider).system).toMatch(/Write everything in Dutch\./);
  });
});

describe("writeCoverLetter", () => {
  const match: Match = {
    items: [{ requirement: "Experience with payments or fintech", result: "gap", skill: null, experienceIds: [], note: null }],
  };
  const answer = {
    recipient: " Ledgerly · Hiring team \n\n Amsterdam ",
    greeting: " Dear Ledgerly team, ",
    paragraphs: [
      { label: "Opening", text: "I was excited to see the role." },
      { label: "", text: "At Northwind I lead the carrier portal." },
      { label: "Empty", text: "  " },
    ],
    signOff: "Cheers,",
  };

  it("returns the recipient, greeting, paragraphs and the tone's sign-off for an English letter (APP-10, E8-11)", async () => {
    const provider = model(answer);
    const { data, promptVersion } = await writeCoverLetter(provider, { profile, extracted, match, tone: "FORMAL", facts: [], posting }, options);
    expect(promptVersion).toBe("write-cover-letter@5");
    expect(data).toEqual([
      { id: "recipient", label: "Recipient", text: "Ledgerly · Hiring team\nAmsterdam" },
      { id: "greeting", label: "Greeting", text: "Dear Ledgerly team," },
      { id: "paragraph:1", label: "Opening", text: "I was excited to see the role." },
      { id: "paragraph:2", label: "Paragraph 2", text: "At Northwind I lead the carrier portal." },
      { id: "sign-off", label: "Sign-off", text: "Kind regards," },
    ]);
    expect(sent(provider).system).toMatch(/Tone: Formal\. Traditional and polished\./);
    expect(sent(provider).system).toMatch(/greeting: the salutation before the first paragraph, usual for a letter in its language/);
    // It says what the resume can't, rather than repeating it.
    expect(sent(provider).system).toContain(COVER_LETTER_APPROACH);
    // Gaps go along, so the letter can acknowledge them honestly.
    expect(prompt(provider)).toMatch(/"inProfile": "gap"/);
  });

  it("leaves out a recipient or greeting the model left empty, for the English ones to fill in", async () => {
    const { data } = await writeCoverLetter(model({ ...answer, recipient: " ", greeting: "" }), { profile, extracted, match: null, tone: "WARM", facts: [], posting }, options);
    expect(data.map((unit) => unit.id)).toEqual(["paragraph:1", "paragraph:2", "sign-off"]);
  });

  it("leaves the greeting, sign-off and name to the renderer", () => {
    const paragraphs = [{ text: "Hi,\nI'm applying for the role." }, { text: "Middle." }, { text: "Thank you for your time.\n\nWarm regards,\nJane Doe" }];
    expect(withoutFrame(paragraphs, "Warm regards,").map((paragraph) => paragraph.text)).toEqual([
      "I'm applying for the role.",
      "Middle.",
      "Thank you for your time.",
    ]);
    expect(withoutFrame([{ text: "Thank you for considering my application. Warm regards,\nLena" }], "Warm regards,")[0].text).toBe(
      "Thank you for considering my application.",
    );
    // A closing word inside a sentence stays.
    expect(withoutFrame([{ text: "It was the best, really." }], "Best,")[0].text).toBe("It was the best, really.");
  });

  it("keeps the model's sign-off in another language", async () => {
    const { data } = await writeCoverLetter(model({ ...answer, signOff: "Met vriendelijke groet," }), { profile, extracted, match: null, tone: "WARM", facts: [], posting }, { ...options, language: "Dutch" });
    expect(data.at(-1)).toEqual({ id: "sign-off", label: "Sign-off", text: "Met vriendelijke groet," });
  });

  it("normalises what the model wrote in every part, keeping a non-breaking space", async () => {
    const written = {
      recipient: "Ledgerly · Hiring team\n​\nAmsterdam",
      greeting: "Dear Ledgerly team,​",
      paragraphs: [
        { label: "Opening", text: "I was excited to see the role on your care­ers page." },
        { label: "Nothing", text: "​" },
      ],
      signOff: "Met vriende­lijke groet,",
    };
    const { data } = await writeCoverLetter(model(written), { profile, extracted, match: null, tone: "WARM", facts: [], posting }, { ...options, language: "Dutch" });
    expect(data).toEqual([
      { id: "recipient", label: "Recipient", text: "Ledgerly · Hiring team\nAmsterdam" },
      { id: "greeting", label: "Greeting", text: "Dear Ledgerly team," },
      { id: "paragraph:1", label: "Opening", text: "I was excited to see the role on your careers page." },
      { id: "sign-off", label: "Sign-off", text: "Met vriendelijke groet," },
    ]);
  });
});

describe("writeEmail", () => {
  const withContact = `${posting}\n\nQuestions? Send your application to John Doe, john.doe@example.com.`;
  const answer = {
    contactName: "John Doe",
    contactEmail: "john.doe@example.com",
    subject: " Application:  Senior Product Designer,\nJane Doe ",
    greeting: "Dear John,",
    paragraphs: ["Dear John,\nI'm applying for the Senior Product Designer role.", "  ", "My resume and cover letter are attached.\n\nWarm regards,\nLena"],
    signOff: "Cheers,",
  };
  const input = { profile, extracted, match: null, tone: "FORMAL" as const, facts: [], posting: withContact, letter: ["Payments are where trust is won."] };

  it("writes the recipient, subject and message, ending with the sign-off and name", async () => {
    const provider = model(answer);
    const { data, promptVersion } = await writeEmail(provider, input, options);
    expect(promptVersion).toBe("write-email@2");
    expect(data).toEqual([
      { id: "to", label: "Recipient", text: "John Doe <john.doe@example.com>" },
      { id: "subject", label: "Subject", text: "Application: Senior Product Designer, Jane Doe" },
      {
        id: "body",
        label: "Message",
        text: `Dear John,\n\nI'm applying for the Senior Product Designer role.\n\nMy resume and cover letter are attached.\n\nKind regards,\n${profile.basics.name}`,
      },
    ]);
    expect(sent(provider).system).toMatch(/Tone: Formal\./);
    // It reads the posting for where to send it, and the letter so it doesn't repeat it.
    expect(prompt(provider)).toContain("Send your application to John Doe");
    expect(prompt(provider)).toContain("The cover letter it goes with:\nPayments are where trust is won.");
    expect(sent(provider).json?.name).toBe("application_email");
  });

  it("never uses an address the posting doesn't have", async () => {
    const { data } = await writeEmail(model({ ...answer, contactEmail: "jobs@example.com" }), input, options);
    expect(data[0]).toEqual({ id: "to", label: "Recipient", text: "" });
  });

  it("keeps the model's sign-off in another language", async () => {
    const { data } = await writeEmail(model({ ...answer, signOff: "Met vriendelijke groet," }), input, { ...options, language: "Dutch" });
    expect(data[2].text).toMatch(new RegExp(`Met vriendelijke groet,\n${profile.basics.name}$`));
  });

  it("marks what the fact guard couldn't back in the message, never in the recipient", async () => {
    const { data } = await writeEmail(model({ ...answer, paragraphs: ["I grew revenue by 40% at Stripe."] }), input, options);
    expect(data[0].unverified).toBeUndefined();
    expect(data[2].unverified).toEqual(expect.arrayContaining(["40%"]));
  });

  it("normalises the subject and the message the model wrote", async () => {
    const written = {
      ...answer,
      subject: "Application: Senior Product De­signer, Jane Doe",
      paragraphs: ["I'm applying for the Senior Product Designer role.​", "​", "My resume and cover letter are at­tached."],
    };
    const { data } = await writeEmail(model(written), input, options);
    expect(data[1].text).toBe("Application: Senior Product Designer, Jane Doe");
    expect(data[2].text).toBe(`Dear John,\n\nI'm applying for the Senior Product Designer role.\n\nMy resume and cover letter are attached.\n\nKind regards,\n${profile.basics.name}`);
  });

  it("names the recipient as the posting gives them", () => {
    expect(recipient(null, "jobs@example.com", "Apply at JOBS@example.com")).toBe("jobs@example.com");
    expect(recipient("John <Doe>", "mailto:john@example.com", "john@example.com")).toBe("John Doe <john@example.com>");
    expect(recipient("John Doe", null, "john@example.com")).toBe("");
    expect(recipient("John Doe", "not an address", "not an address")).toBe("");
    // A posting that hides a soft hyphen or a zero-width space in the address still gives it, without them.
    expect(recipient(null, "jobs@ledg­erly.example", "Apply at jobs@ledg­erly.example")).toBe("jobs@ledgerly.example");
    expect(recipient(null, "jobs@ledgerly.example", "Apply at jobs@​ledgerly.example")).toBe("jobs@ledgerly.example");
  });
});

describe("translateDocument", () => {
  const parts = [
    { id: "summary", label: "Summary", text: "Product designer who makes complex tools calm." },
    { id: "experience:e1", label: "Northwind role", text: "Led the carrier portal\nBuilt the design system" },
    { id: "skills", label: "Skills", text: "Figma, Design systems" },
  ];

  it("asks for the parts in the language, as they are, and returns each one cleaned up (translate)", async () => {
    const provider = model({
      parts: [
        { unitId: "summary", text: "\uFEFFProduktdesigner, der komplexe Werkzeuge ruhig macht.​" },
        { unitId: "experience:e1", text: "- Das Carrier-Portal geleitet\n• Das Designsystem aufgebaut" },
        { unitId: "skills", text: "Figma, Designsysteme" },
      ],
    });
    const { data, promptVersion } = await translateDocument(provider, { kind: "RESUME", language: "German", units: parts }, options);
    expect(promptVersion).toBe("translate-document@1");
    expect(data.missing).toEqual([]);
    expect(data.translated).toEqual([
      { id: "summary", text: "Produktdesigner, der komplexe Werkzeuge ruhig macht." },
      { id: "experience:e1", text: "Das Carrier-Portal geleitet\nDas Designsystem aufgebaut" },
      { id: "skills", text: "Figma, Designsysteme" },
    ]);
    expect(sent(provider).system).toContain("again in German");
    expect(sent(provider).system).toMatch(/Keep exactly as they are: numbers, amounts, the names of people, companies/);
    expect(sent(provider).messages[0].content).toContain("Write these parts of the resume in German");
    expect(sent(provider).messages[0].content).toContain("Led the carrier portal");
    // A translation follows the original: no creative phrasing, whatever Settings says.
    expect(sent(provider).temperature).toBe(0.2);
  });

  it("names what the model left out, and ignores parts it wasn't given and repeats", async () => {
    const provider = model({
      parts: [
        { unitId: "summary", text: "Erste Fassung." },
        { unitId: "summary", text: "Zweite Fassung." },
        { unitId: "sender", text: "Ein Teil, der nicht gefragt war." },
        { unitId: "skills", text: "   " },
      ],
    });
    const { data } = await translateDocument(provider, { kind: "RESUME", language: "German", units: parts }, options);
    expect(data.translated).toEqual([{ id: "summary", text: "Erste Fassung." }]);
    expect(data.missing).toEqual(["experience:e1", "skills"]);
  });

  it("calls the letter and the email by their names", async () => {
    const letter = model({ parts: [] });
    await translateDocument(letter, { kind: "COVER_LETTER", language: "Dutch", units: [parts[0]] }, options);
    expect(sent(letter).messages[0].content).toContain("parts of the cover letter in Dutch");
    const email = model({ parts: [] });
    await translateDocument(email, { kind: "EMAIL", language: "Dutch", units: [parts[0]] }, options);
    expect(sent(email).system).toContain("candidate's application email again in Dutch");
  });
});

describe("regenerateUnit", () => {
  it("writes one part again, cleaning up bullets (APP-5)", async () => {
    const resume = demoResumeUnits();
    const unit = resume.find((entry) => entry.id === "experience:e1")!;
    const provider = model({ text: "- Rebuilt the carrier portal\n• Grew the design system\n" });
    const { data, promptVersion } = await regenerateUnit(provider, { kind: "RESUME", unit, document: resume, profile, extracted, tone: "WARM", facts: [], posting }, options);
    expect(promptVersion).toBe("regenerate-unit@6");
    expect(data).toMatchObject({ id: "experience:e1", text: "Rebuilt the carrier portal\nGrew the design system" });
    expect(prompt(provider)).toContain(`Write a new version of "${unit.label}" (experience:e1)`);
    expect(sent(provider).system).not.toContain(COVER_LETTER_APPROACH);
  });

  it("reads a non-breaking hyphen as a bullet and takes invisible characters out of the new text", async () => {
    const resume = demoResumeUnits();
    const unit = resume.find((entry) => entry.id === "experience:e1")!;
    const provider = model({ text: "‑ Rebuilt the carrier portal\n​\n• Grew the design sys­tem" });
    const { data } = await regenerateUnit(provider, { kind: "RESUME", unit, document: resume, profile, extracted, tone: "WARM", facts: [], posting }, options);
    expect(data.text).toBe("Rebuilt the carrier portal\nGrew the design system");

    const summary = { id: "summary", label: "Summary", text: "Product designer." };
    const prose = model({ text: "﻿Product de­signer who makes complex tools calm.​" });
    const { data: regenerated } = await regenerateUnit(prose, { kind: "RESUME", unit: summary, document: [summary], profile, extracted, tone: "WARM", facts: [], posting }, options);
    expect(regenerated.text).toBe("Product designer who makes complex tools calm.");
  });

  it("keeps an English letter's sign-off the tone's", async () => {
    const unit = { id: "sign-off", label: "Sign-off", text: "Warm regards," };
    const provider = model({ text: "Yours truly," });
    const { data } = await regenerateUnit(provider, { kind: "COVER_LETTER", unit, document: [unit], profile, extracted, tone: "DIRECT", facts: [], posting }, options);
    expect(data.text).toBe("Best,");
    expect(sent(provider).system).toContain(COVER_LETTER_APPROACH);
  });

  it("tells the model what the email's message is, with the tone", async () => {
    const unit = { id: "body", label: "Message", text: "Dear John,\n\nHello.\n\nWarm regards,\nLena" };
    const provider = model({ text: "Dear John,\n\nHi again." });
    const { data } = await regenerateUnit(provider, { kind: "EMAIL", unit, document: [unit], profile, extracted, tone: "DIRECT", facts: [], posting }, options);
    expect(data.text).toBe("Dear John,\n\nHi again.");
    expect(sent(provider).system).toMatch(/one part of a candidate's application email/);
    expect(sent(provider).system).toMatch(/It's the email's whole message/);
    expect(sent(provider).system).toMatch(/Tone: Direct\./);
    expect(sent(provider).system).not.toContain(COVER_LETTER_APPROACH);
  });

  it("tells the model what a letter's greeting is, without the letter's brief (E8-11)", async () => {
    const unit = { id: "greeting", label: "Greeting", text: "Dear Ledgerly team," };
    const provider = model({ text: "Dear hiring team," });
    await regenerateUnit(provider, { kind: "COVER_LETTER", unit, document: [unit], profile, extracted, tone: "WARM", facts: [], posting }, options);
    expect(sent(provider).system).toMatch(/It's the letter's greeting/);
    expect(sent(provider).system).not.toContain(COVER_LETTER_APPROACH);
  });
});

describe("refineChat", () => {
  const resume = demoResumeUnits();
  const letter = [...demoLetterUnits(), { id: "sign-off", label: "Sign-off", text: "Warm regards," }];
  const input = { request: "Make it more formal", history: [], target: null, resume, letter, profile, extracted, tone: "WARM" as const, facts: [], posting };

  it("returns a reply and edits with what they replace, for Undo (APP-7, APP-8)", async () => {
    const answer = {
      reply: "I made the letter more formal.",
      edits: [
        { document: "COVER_LETTER", unitId: "paragraph:1", text: "Please accept my application." },
        { document: "COVER_LETTER", unitId: "paragraph:99", text: "Invented unit" },
        { document: "RESUME", unitId: "summary", text: resume[0].text },
      ],
      tone: "FORMAL",
      declined: false,
    };
    const { data, promptVersion } = await refineChat(model(answer), input, options);
    expect(promptVersion).toBe("refine-chat@7");
    expect(data).toEqual({
      reply: "I made the letter more formal.",
      tone: "FORMAL",
      declined: false,
      edits: [
        { document: "COVER_LETTER", unitId: "paragraph:1", text: "Please accept my application.", previousText: letter[0].text },
        // A new tone brings its sign-off along.
        { document: "COVER_LETTER", unitId: "sign-off", text: "Kind regards,", previousText: "Warm regards," },
      ],
    });
  });

  it("normalises an edit's text, and skips one that only differs in invisible characters", async () => {
    const answer = {
      reply: "Done.",
      edits: [
        { document: "COVER_LETTER", unitId: "paragraph:1", text: "Please accept my ap­plication for the role of designer." },
        { document: "RESUME", unitId: "summary", text: `​${resume[0].text}` },
      ],
      tone: null,
      declined: false,
    };
    const { data } = await refineChat(model(answer), input, options);
    expect(data.edits).toEqual([
      { document: "COVER_LETTER", unitId: "paragraph:1", text: "Please accept my application for the role of designer.", previousText: letter[0].text },
    ]);
  });

  it("never edits a publication (#218)", async () => {
    const answer = {
      reply: "Shortened your publication.",
      edits: [{ document: "RESUME", unitId: "publication:u1", text: "Doe, J. (2016)." }],
      tone: null,
      declined: false,
    };
    const provider = model(answer);
    const { data } = await refineChat(provider, input, options);
    expect(data.edits).toEqual([]);
    expect(sent(provider).system).toMatch(/Never edit a publication/);
  });

  it("declines with guidance instead of inventing facts (APP-9)", async () => {
    const answer = {
      reply: "Your profile doesn't mention fintech work yet. Add it under Experience and I'll use it.",
      edits: [{ document: "RESUME", unitId: "summary", text: "Fintech expert." }],
      tone: null,
      declined: true,
    };
    const { data } = await refineChat(model(answer), { ...input, request: "Say I worked at a bank" }, options);
    expect(data).toMatchObject({ declined: true, edits: [], tone: null });
  });

  it("sends the conversation so far and the unit it's about", async () => {
    const provider = model({ reply: "Done.", edits: [], tone: null, declined: false });
    await refineChat(provider, { ...input, target: "Summary", history: [{ role: "user", text: "Hi" }, { role: "assistant", text: "Hello!" }] }, options);
    const messages = sent(provider).messages;
    expect(messages.slice(-3)).toEqual([
      { role: "user", content: "Hi" },
      { role: "assistant", content: "Hello!" },
      { role: "user", content: "About Summary: Make it more formal" },
    ]);
  });

  it("edits the email, which it sees when there is one", async () => {
    const email = [
      { id: "to", label: "Recipient", text: "john@example.com" },
      { id: "subject", label: "Subject", text: "Application" },
      { id: "body", label: "Message", text: "Dear John,\n\nHello." },
    ];
    const answer = { reply: "Shorter now.", edits: [{ document: "EMAIL", unitId: "body", text: "Dear John,\n\nHi." }], tone: null, declined: false };
    const provider = model(answer);
    const { data } = await refineChat(provider, { ...input, email, viewing: "EMAIL", request: "Shorter" }, options);
    expect(data.edits).toEqual([{ document: "EMAIL", unitId: "body", text: "Dear John,\n\nHi.", previousText: "Dear John,\n\nHello." }]);
    expect(prompt(provider)).toContain("The email's units:");
    expect(sent(provider).messages.at(-1)).toEqual({ role: "user", content: "(I'm looking at the email.) Shorter" });

    const without = model(answer);
    const { data: none } = await refineChat(without, input, options);
    expect(none.edits).toEqual([]);
    expect(prompt(without)).not.toContain("The email's units:");
  });

  it("says which document is on screen when the request has no target", async () => {
    const provider = model({ reply: "Done.", edits: [], tone: null, declined: false });
    await refineChat(provider, { ...input, request: "Make it shorter", viewing: "COVER_LETTER" }, options);
    expect(sent(provider).messages.at(-1)).toEqual({ role: "user", content: "(I'm looking at the cover letter.) Make it shorter" });
  });

  it("keeps the fact guard's hints on the replaced text, for Undo", async () => {
    const flagged = resume.map((unit) => (unit.id === "summary" ? { ...unit, unverified: ["2019"] } : unit));
    const answer = { reply: "Shorter now.", edits: [{ document: "RESUME", unitId: "summary", text: "Product designer." }], tone: null, declined: false };
    const { data } = await refineChat(model(answer), { ...input, resume: flagged }, options);
    expect(data.edits[0]).toMatchObject({ previousText: resume[0].text, previousUnverified: ["2019"] });
  });
});

describe("the fact guard in the writing tasks (E6-6)", () => {
  const answer = {
    summary: "Led a team of 12 at Google; nine years of design at Northwind Logistics.",
    roles: [{ id: "e1", bullets: ["Led the redesign of the carrier portal used daily by 4,000+ dispatchers"] }],
    projects: [],
    skills: ["Figma"],
    education: [],
  };

  it("notes what the profile and posting don't back, in strict mode", async () => {
    const { data } = await tailorResume(model(answer), { profile, extracted, match: null, facts: [], posting }, options);
    expect(data.find((unit) => unit.id === "summary")?.unverified).toEqual(["Google", "12"]);
    expect(data.find((unit) => unit.id === "experience:e1")).not.toHaveProperty("unverified");
  });

  it("stays out of the way when strict mode is off", async () => {
    const { data } = await tailorResume(model(answer), { profile, extracted, match: null, facts: [], posting }, { ...options, strict: false });
    expect(data.some((unit) => unit.unverified)).toBe(false);
  });

  it("checks the letter, a regenerated unit and chat edits too", async () => {
    const letter = await writeCoverLetter(model({ recipient: "", greeting: "", paragraphs: [{ label: "Opening", text: "I grew revenue by 40% at Stripe." }], signOff: "" }), { profile, extracted, match: null, tone: "WARM", facts: [], posting }, options);
    expect(letter.data[0].unverified).toEqual(["Stripe", "40%"]);

    const unit = { id: "summary", label: "Summary", text: "Product designer." };
    const regenerated = await regenerateUnit(model({ text: "PhD-trained designer." }), { kind: "RESUME", unit, document: [unit], profile, extracted, tone: "WARM", facts: [], posting }, options);
    expect(regenerated.data.unverified).toEqual(["PhD-trained"]);

    const refined = await refineChat(
      model({ reply: "Done.", edits: [{ document: "RESUME", unitId: "summary", text: "Designer with 25 years at IBM." }], tone: null, declined: false }),
      { request: "Punchier", history: [], target: null, resume: [unit], letter: [], profile, extracted, tone: "WARM", facts: [], posting },
      options,
    );
    expect(refined.data.edits[0].unverified).toEqual(["IBM", "25"]);
  });
});


describe("the profile photo (#224)", () => {
  const withPhoto = {
    ...profile,
    photo: { src: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", onResumes: true },
  };

  it("is never in a prompt", async () => {
    const calls = [
      (provider: MockProvider) =>
        tailorResume(provider, { profile: withPhoto, extracted, match: null, facts: [], posting }, options),
      (provider: MockProvider) =>
        writeCoverLetter(provider, { profile: withPhoto, extracted, match: null, tone: "WARM", facts: [], posting }, options),
      (provider: MockProvider) =>
        writeEmail(provider, { profile: withPhoto, extracted, match: null, tone: "WARM", facts: [], posting, letter: [] }, options),
    ];
    for (const call of calls) {
      const provider = new MockProvider({ reply: () => ({}) });
      // An empty answer fails, after a retry: what matters is what was sent.
      await call(provider).catch(() => undefined);
      expect(provider.calls.length).toBeGreaterThan(0);
      for (const { system, messages } of provider.calls) {
        expect([system, ...messages.map((message) => message.content)].join("\n")).not.toMatch(/data:image|iVBORw0KGgo|"photo"/);
      }
    }
  });
});
