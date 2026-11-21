import { describe, expect, it, vi } from "vitest";

import { MockProvider } from "@/lib/ai/providers/mock";

import { WRITE_DOCUMENTS_STEPS } from "./application-steps";
import { writeDocumentsJob } from "./write-documents";

const provider = vi.hoisted(() => ({ current: undefined as unknown }));
vi.mock("@/lib/ai", () => ({ getAiProvider: async () => provider.current }));
// Settings → Write documents in.
const settings = vi.hoisted(() => ({ language: null as string | null }));
vi.mock("@/lib/ai/task-options", () => ({ loadTaskOptions: async () => ({ creativity: "BALANCED", strict: true, language: settings.language }) }));
vi.mock("@/lib/profile-data", async () => {
  const { demoProfile } = await import("@/lib/demo-profile");
  return { loadProfile: async () => demoProfile() };
});
// Shared settings: the standard answers (jobauto fork). The Base resume's own are the profile's (E24-1).
vi.mock("@/lib/settings-data", () => ({ loadSettings: async () => ({ applyAnswers: { salary: "", startDate: "", noticePeriod: "", workPermit: true, germanCourse: "", degreeRecognition: "" } }) }));
vi.mock("@/lib/profiles", () => ({ loadProfileSettings: async () => ({ resumeSections: { order: [], off: [] }, skillOrder: "relevance" }) }));
vi.mock("./runner", () => ({ defineJob: <T,>(definition: T) => definition }));

describe("writeDocumentsJob (E7-6)", () => {
  it("tailors the resume, then writes the letter, naming each step", async () => {
    provider.current = new MockProvider({
      reply: (call) =>
        call.json?.name === "tailored_resume"
          ? { summary: "Designer at Google.", roles: [], projects: [], skills: ["Figma"], education: [] }
          : { recipient: "Ledgerly · Hiring team", greeting: "Dear Ledgerly team,", paragraphs: [{ label: "Opening", text: "I'd love to join Ledgerly." }], signOff: "Warm regards," },
    });
    const steps: string[] = [];
    const extracted = {
      title: "Designer · Ledgerly", company: "Ledgerly", role: "Designer", location: null, mode: null, salary: null, deadline: null,
      requirements: [], asksForReferences: false, language: "English",
    };
    const result = await writeDocumentsJob.run(
      { readJobId: "read-job", posting: "Ledgerly is hiring.", extracted, match: { items: [] }, tone: "WARM", note: "", write: "both" },
      { id: "test-job", step: async (name) => void steps.push(name), signal: new AbortController().signal },
    );
    expect(steps).toEqual(WRITE_DOCUMENTS_STEPS.slice(0, 2));
    expect(result.resumeWith).toBe("tailor-resume@10");
    expect(result.letterWith).toBe("write-cover-letter@9");
    // Strict mode: the fact guard marks what the profile doesn't back.
    expect(result.resume[0]).toMatchObject({ id: "summary", unverified: ["Google"] });
    expect(result.letter.map((unit) => unit.id)).toEqual(["recipient", "greeting", "paragraph:1", "sign-off"]);
  });

  it("writes only the document asked for (#367)", async () => {
    const asked: string[] = [];
    provider.current = new MockProvider({
      reply: (call) => {
        asked.push(call.json?.name ?? "");
        return call.json?.name === "tailored_resume"
          ? { summary: "Designer.", roles: [], projects: [], skills: ["Figma"], education: [] }
          : { recipient: "Ledgerly · Hiring team", greeting: "Dear Ledgerly team,", paragraphs: [{ label: "Opening", text: "I'd love to join Ledgerly." }], signOff: "Warm regards," };
      },
    });
    const extracted = {
      title: "Designer · Ledgerly", company: "Ledgerly", role: "Designer", location: null, mode: null, salary: null, deadline: null,
      requirements: [], asksForReferences: false, language: "English",
    };
    const steps: string[] = [];
    const context = { id: "test-job", step: async (name: string) => void steps.push(name), signal: new AbortController().signal };
    const input = { readJobId: "read-job", posting: "Ledgerly is hiring.", extracted, match: { items: [] }, tone: "WARM" as const, note: "" };

    const resumeOnly = await writeDocumentsJob.run({ ...input, write: "resume" }, context);
    expect(asked).toEqual(["tailored_resume"]);
    expect(resumeOnly).toMatchObject({ letter: [], letterWith: "", resumeWith: "tailor-resume@10" });

    asked.length = 0;
    steps.length = 0;
    const letterOnly = await writeDocumentsJob.run({ ...input, write: "letter" }, context);
    expect(asked).toEqual(["cover_letter"]);
    expect(steps).toEqual([WRITE_DOCUMENTS_STEPS[1]]);
    expect(letterOnly).toMatchObject({ resume: [], resumeWith: "", letterWith: "write-cover-letter@9" });
  });

  describe("the language of the documents", () => {
    const extracted = {
      title: "Designer · Ledgerly", company: "Ledgerly", role: "Designer", location: null, mode: null, salary: null, deadline: null,
      requirements: [], asksForReferences: false, language: "English",
    };
    const model = () =>
      new MockProvider({
        reply: (call) =>
          call.json?.name === "tailored_resume"
            ? { summary: "Designer.", roles: [], projects: [], skills: ["Figma"], education: [] }
            : { recipient: "Ledgerly", greeting: "Hello,", paragraphs: [{ label: "Opening", text: "Hi." }], signOff: "Regards," },
      });
    const run = async (extra: { language?: string | null }, inSettings: string | null) => {
      settings.language = inSettings;
      const mock = model();
      provider.current = mock;
      await writeDocumentsJob.run(
        { readJobId: "read-job", posting: "Ledgerly is hiring.", extracted, match: { items: [] }, tone: "WARM", note: "", write: "both", ...extra },
        { id: "test-job", step: async () => {}, signal: new AbortController().signal },
      );
      settings.language = null;
      return mock.calls.map((call) => call.system);
    };

    it("writes in the language chosen for the application, over Settings", async () => {
      const [resume, letter] = await run({ language: "German" }, "Dutch");
      expect(resume).toContain("Write everything in German.");
      expect(letter).toContain("Write everything in German.");
    });

    it("writes in the posting's language when that was chosen, whatever Settings says", async () => {
      const [resume, letter] = await run({ language: null }, "Dutch");
      expect(resume).toContain("Write everything in English.");
      expect(resume).not.toContain("Dutch");
      // The letter is told the posting's language outright too, so an English profile doesn't decide it.
      expect(letter).toContain("Write everything in English.");
      expect(letter).not.toContain("Dutch");
    });

    it("follows Settings for a job from before the language was chosen per application", async () => {
      const [resume] = await run({}, "Dutch");
      expect(resume).toContain("Write everything in Dutch.");
    });
  });
});
