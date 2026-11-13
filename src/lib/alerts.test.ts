import { afterEach, describe, expect, it, vi } from "vitest";

import { AlertError, matchLines, sendAlert } from "./alerts";

vi.mock("@/lib/env", () => ({ env: { DOSSIER_PUBLIC_URL: "https://dossier.example" } }));
vi.mock("@/lib/settings-data", () => ({ loadSettings: vi.fn(), saveSettings: vi.fn() }));

afterEach(() => vi.unstubAllGlobals());

describe("sendAlert", () => {
  it("publishes JSON to the ntfy server's root, with the topic, umlauts as written and a link into Dossier", async () => {
    const fetch = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", fetch);
    await sendAlert("https://ntfy.sh/jobauto-abc", { title: "Neue Stelle: Prüferin", message: "88 · Analyst, Müller AG", open: "/agent" });
    expect(fetch).toHaveBeenCalledWith("https://ntfy.sh/", expect.objectContaining({ method: "POST" }));
    const body = JSON.parse((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body).toEqual({ topic: "jobauto-abc", title: "Neue Stelle: Prüferin", message: "88 · Analyst, Müller AG", click: "https://dossier.example/agent", tags: ["briefcase"] });
  });

  it("says what went wrong in words", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 403 })));
    await expect(sendAlert("https://ntfy.sh/topic", { title: "t", message: "m" })).rejects.toThrow("ntfy.sh answered 403: the topic needs a login.");
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("fetch failed"))));
    await expect(sendAlert("https://ntfy.sh/topic", { title: "t", message: "m" })).rejects.toThrow(AlertError);
    await expect(sendAlert("not a topic", { title: "t", message: "m" })).rejects.toThrow("That isn't an ntfy topic address");
  });
});

describe("matchLines", () => {
  it("lists the first few, best first as given, and how many more", () => {
    const postings = Array.from({ length: 7 }, (_, index) => ({ title: `Role ${index + 1}`, company: "Acme", score: 90 - index }));
    expect(matchLines(postings).split("\n")).toEqual(["90 · Role 1, Acme", "89 · Role 2, Acme", "88 · Role 3, Acme", "87 · Role 4, Acme", "86 · Role 5, Acme", "and 2 more"]);
    expect(matchLines([{ title: "Analyst", company: "" }])).toBe("Analyst");
  });
});
