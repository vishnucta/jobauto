import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createTestClient, resetDatabase } from "@/test/db";

import { addRecruiter, addSuggestedRecruiters, deleteRecruiter, moveRecruiter, saveRecruiter, snoozeFollowUp } from "./actions";

const db = vi.hoisted(() => ({ client: undefined as ReturnType<typeof createTestClient> | undefined }));
vi.mock("@/lib/prisma", async () => {
  const { createTestClient } = await import("@/test/db");
  db.client = createTestClient();
  return { prisma: db.client };
});
vi.mock("@/lib/auth/session", () => ({
  getSession: async () => ({ persistent: false, issuedAt: new Date(), expiresAt: new Date(Date.now() + 60_000) }),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const prisma = () => db.client!;
const fields = { name: "Selby Jennings", contactName: "", email: "", website: "", speciality: "", notes: "" };

beforeEach(() => resetDatabase(prisma()));
afterAll(() => prisma().$disconnect());

describe("the Recruiters actions", () => {
  it("add a recruiter, trimmed, and move it through the conversation", async () => {
    const added = await addRecruiter({ ...fields, name: "  Hays  ", email: "jobs@hays.example", website: "https://www.hays.de" });
    expect(added).toMatchObject({ ok: true, data: { name: "Hays", email: "jobs@hays.example", status: "NOT_CONTACTED" } });
    const id = added.ok ? added.data.id : "";

    expect(await moveRecruiter({ id, status: "CONTACTED" })).toMatchObject({ ok: true, data: { status: "CONTACTED" } });
    expect(await snoozeFollowUp({ id })).toMatchObject({ ok: true, data: { status: "CONTACTED" } });
    expect(await moveRecruiter({ id, status: "REPLIED" })).toMatchObject({ ok: true, data: { status: "REPLIED", followUpAt: null } });
    // Replied: nothing left to snooze.
    expect(await snoozeFollowUp({ id })).toEqual({ ok: false, error: "Only a recruiter you're waiting to hear from can be snoozed." });
  });

  it("say what is wrong with a name, an email or a website, and save nothing", async () => {
    expect(await addRecruiter({ ...fields, name: "  " })).toMatchObject({ ok: false, fieldErrors: { name: ["Give the agency or recruiter a name."] } });
    expect(await addRecruiter({ ...fields, email: "not an address" })).toMatchObject({ ok: false, fieldErrors: { email: ["That doesn't look like an email address."] } });
    expect(await addRecruiter({ ...fields, website: "javascript:alert(1)" })).toMatchObject({ ok: false, fieldErrors: { website: ["A website starts with https://"] } });
    expect(await prisma().recruiter.count()).toBe(0);
  });

  it("save details, and refuse a recruiter that is gone", async () => {
    const added = await addRecruiter(fields);
    const id = added.ok ? added.data.id : "";
    expect(await saveRecruiter({ id, ...fields, contactName: "Alex", notes: "Ask who the client is." })).toMatchObject({ ok: true, data: { contactName: "Alex", notes: "Ask who the client is." } });
    const gone = "That recruiter is no longer in the list. Reload the page.";
    expect(await saveRecruiter({ id: "gone", ...fields })).toEqual({ ok: false, error: gone });
    expect(await moveRecruiter({ id: "gone", status: "CONTACTED" })).toEqual({ ok: false, error: gone });
    expect(await deleteRecruiter({ id: "gone" })).toEqual({ ok: false, error: gone });
  });

  it("remove one with a toast, and add the suggested agencies once", async () => {
    const added = await addRecruiter(fields);
    const id = added.ok ? added.data.id : "";
    expect(await deleteRecruiter({ id })).toEqual({ ok: true, data: null, toast: "Recruiter removed." });
    expect(await addSuggestedRecruiters({})).toEqual({ ok: true, data: { added: 4 }, toast: "Added 4 agencies." });
    expect(await addSuggestedRecruiters({})).toEqual({ ok: true, data: { added: 0 }, toast: "They're all on your list already." });
  });
});
