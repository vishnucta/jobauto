import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createTestClient, resetDatabase } from "@/test/db";

import { addStarterRecruiters, createRecruiter, listRecruiters, noteAgencies, removeRecruiter, setRecruiterStatus, snoozeRecruiter, updateRecruiter } from "./store";
import { STARTER_RECRUITERS } from "./types";

const db = vi.hoisted(() => ({ client: undefined as ReturnType<typeof createTestClient> | undefined }));
vi.mock("@/lib/prisma", async () => {
  const { createTestClient } = await import("@/test/db");
  db.client = createTestClient();
  return { prisma: db.client };
});

const prisma = () => db.client!;
const NOW = new Date("2026-11-10T09:00:00.000Z");
const fields = { name: "Selby Jennings", contactName: "", email: "", website: "", speciality: "Financial services", notes: "" };

beforeEach(() => resetDatabase(prisma()));
afterAll(() => prisma().$disconnect());

describe("recruiters", () => {
  it("are added with a line in their history, and listed oldest first", async () => {
    const first = await createRecruiter(fields);
    await createRecruiter({ ...fields, name: "Hays" });
    expect(first).toMatchObject({ name: "Selby Jennings", status: "NOT_CONTACTED", contactedAt: null, followUpAt: null, source: "you", events: [{ text: "Added" }] });
    expect((await listRecruiters()).map((entry) => entry.name)).toEqual(["Selby Jennings", "Hays"]);
  });

  it("start the follow-up clock when written to, and stop it on a reply", async () => {
    const { id } = await createRecruiter(fields);
    const written = await setRecruiterStatus(id, "CONTACTED", NOW);
    expect(written).toMatchObject({ status: "CONTACTED", contactedAt: NOW.toISOString(), followUpAt: "2026-11-17T09:00:00.000Z" });
    expect(written!.events.map((event) => event.text)).toEqual(["Added", "Marked as contacted"]);

    const replied = await setRecruiterStatus(id, "REPLIED", new Date("2026-11-12T09:00:00.000Z"));
    expect(replied).toMatchObject({ status: "REPLIED", contactedAt: NOW.toISOString(), followUpAt: null });
    expect(replied!.events.at(-1)).toMatchObject({ text: "They replied", at: "2026-11-12T09:00:00.000Z" });

    // Writing again starts a new clock.
    const again = await setRecruiterStatus(id, "CONTACTED", new Date("2026-11-13T09:00:00.000Z"));
    expect(again).toMatchObject({ contactedAt: "2026-11-13T09:00:00.000Z", followUpAt: "2026-11-20T09:00:00.000Z" });

    const back = await setRecruiterStatus(id, "NOT_CONTACTED", NOW);
    expect(back).toMatchObject({ status: "NOT_CONTACTED", contactedAt: null, followUpAt: null });
  });

  it("can wait a few more days before a follow-up, but only while waiting for an answer", async () => {
    const { id } = await createRecruiter(fields);
    expect(await snoozeRecruiter(id, NOW)).toBeNull();
    await setRecruiterStatus(id, "CONTACTED", NOW);
    const later = new Date("2026-11-17T09:00:00.000Z");
    expect(await snoozeRecruiter(id, later)).toMatchObject({ followUpAt: "2026-11-20T09:00:00.000Z", contactedAt: NOW.toISOString() });
    expect((await listRecruiters())[0].events.at(-1)?.text).toBe("Snoozed for 3 days");
  });

  it("keep their details when saved, and say when one is gone", async () => {
    const { id } = await createRecruiter(fields);
    const saved = await updateRecruiter(id, { ...fields, contactName: "Alex Kuhn", email: "alex@example.com", notes: "Ask who the client is." });
    expect(saved).toMatchObject({ contactName: "Alex Kuhn", email: "alex@example.com", notes: "Ask who the client is.", status: "NOT_CONTACTED" });
    expect(await updateRecruiter("gone", fields)).toBeNull();
    expect(await setRecruiterStatus("gone", "CONTACTED", NOW)).toBeNull();
  });

  it("take their history with them when removed", async () => {
    const { id } = await createRecruiter(fields);
    await setRecruiterStatus(id, "CONTACTED", NOW);
    expect(await prisma().recruiterEvent.count()).toBe(2);
    expect(await removeRecruiter(id)).toBe(true);
    expect(await removeRecruiter(id)).toBe(false);
    expect(await prisma().recruiterEvent.count()).toBe(0);
  });

  it("get the starter agencies once each, whatever the case of a name already there", async () => {
    await createRecruiter({ ...fields, name: "ROBERT WALTERS" });
    expect(await addStarterRecruiters()).toBe(STARTER_RECRUITERS.length - 1);
    expect(await addStarterRecruiters()).toBe(0);
    const list = await listRecruiters();
    expect(list).toHaveLength(STARTER_RECRUITERS.length);
    expect(list.filter((entry) => entry.source === "starter list").every((entry) => entry.email === "" && entry.website.startsWith("https://"))).toBe(true);
    expect(list.find((entry) => entry.name === "Hays")?.events[0].text).toBe("Added from the starter list");
  });
});

describe("agencies noted from searches and jobs", () => {
  it("are added with where they were found and the roles they posted, once each", async () => {
    const added = await noteAgencies(
      [
        { company: "Selby Jennings", title: "Regulatory Reporting Specialist (m/w/d)" },
        { company: "Selby Jennings", title: "Team Leader Transaction Reporting" },
        { company: "Fielmann AG", title: "Financial Analyst" },
        { company: "Michael Page", title: "Commercial Finance Analyst" },
      ],
      "search",
    );
    expect(added).toBe(2);
    const list = await listRecruiters();
    expect(list.map((entry) => [entry.name, entry.source, entry.status])).toEqual([
      ["Selby Jennings", "found in search", "NOT_CONTACTED"],
      ["Michael Page", "found in search", "NOT_CONTACTED"],
    ]);
    expect(list[0].events.map((event) => event.text)).toEqual(["Found in a search", "Posted: Regulatory Reporting Specialist (m/w/d)", "Posted: Team Leader Transaction Reporting"]);

    // The same search again changes nothing; a new role adds one line to the agency already there.
    expect(await noteAgencies([{ company: "Selby Jennings", title: "Team Leader Transaction Reporting" }], "search")).toBe(0);
    expect(await noteAgencies([{ company: "SELBY JENNINGS", title: "Financial Analyst (Renewables)" }], "job")).toBe(0);
    const after = await listRecruiters();
    expect(after).toHaveLength(2);
    expect(after[0].events.at(-1)?.text).toBe("Posted: Financial Analyst (Renewables)");
    expect(after[0].events).toHaveLength(4);
  });

  it("keep the one the user already added, whatever the spelling, and say a job brought it", async () => {
    await createRecruiter({ ...fields, name: "robert walters" });
    expect(await noteAgencies([{ company: "Robert Walters Germany", title: "Controller" }], "search")).toBe(0);
    expect(await prisma().recruiter.count()).toBe(1);
    expect(await noteAgencies([{ company: "Hays", title: "Financial Analyst" }], "job")).toBe(1);
    expect((await listRecruiters()).find((entry) => entry.name === "Hays")).toMatchObject({ source: "came with a job", events: [{ text: "Came with a job" }, { text: "Posted: Financial Analyst" }] });
  });

  it("stay off the list once removed, until the user adds them again", async () => {
    await noteAgencies([{ company: "Hays", title: "Analyst" }], "search");
    const [hays] = await listRecruiters();
    expect(await removeRecruiter(hays.id)).toBe(true);
    expect(await prisma().recruiterBlock.findMany()).toMatchObject([{ key: "hays" }]);

    expect(await noteAgencies([{ company: "Hays", title: "Another role" }], "search")).toBe(0);
    expect(await prisma().recruiter.count()).toBe(0);

    await createRecruiter({ ...fields, name: "Hays" });
    expect(await prisma().recruiterBlock.count()).toBe(0);
    expect(await noteAgencies([{ company: "Hays", title: "Third role" }], "search")).toBe(0);
    expect((await listRecruiters())[0].events.at(-1)?.text).toBe("Posted: Third role");
  });

  it("never fail the search or the application they come from", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(prisma().recruiter, "findMany").mockRejectedValueOnce(new Error("database is down"));
    await expect(noteAgencies([{ company: "Hays", title: "Analyst" }], "search")).resolves.toBe(0);
    expect(console.error).toHaveBeenCalledTimes(1);
  });
});
