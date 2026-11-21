import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createTestClient, resetDatabase } from "@/test/db";

import { importConnections, NetworkError, networkSummary, peopleAt } from "./network-data";

const db = vi.hoisted(() => ({ client: undefined as ReturnType<typeof createTestClient> | undefined }));
vi.mock("@/lib/prisma", async () => {
  const { createTestClient } = await import("@/test/db");
  db.client = createTestClient();
  return { prisma: db.client };
});
const prisma = () => db.client!;

const EXPORT = (rows: string[]) => `Notes:\n"Some email addresses may be missing."\n\nFirst Name,Last Name,URL,Email Address,Company,Position,Connected On\n${rows.join("\n")}\n`;

beforeEach(() => resetDatabase(prisma()));
afterAll(() => prisma().$disconnect());

describe("her LinkedIn network", () => {
  it("imports the export, replacing the last one, and says who she knows at each employer", async () => {
    expect(await importConnections(EXPORT(["Old,Contact,,,Old Co,Analyst,01 Jan 2020"]))).toBe(1);
    expect(
      await importConnections(
        EXPORT([
          'Sam,Beispiel,https://www.linkedin.com/in/sam,,"Joh. Berenberg, Gossler & Co. KG",Head of Regulatory Reporting,05 Nov 2024',
          "Alex,Muster,https://www.linkedin.com/in/alex,,Hays,Senior Recruiter,12 Jan 2023",
        ]),
      ),
    ).toBe(2);
    expect(await networkSummary()).toMatchObject({ people: 2 });

    const known = await peopleAt(["Berenberg", "Hays Professional Solutions GmbH", "Old Co", "Nobody GmbH"]);
    expect(Object.keys(known)).toEqual(["Berenberg", "Hays Professional Solutions GmbH"]);
    expect(known.Berenberg).toEqual([expect.objectContaining({ name: "Sam Beispiel", position: "Head of Regulatory Reporting", url: "https://www.linkedin.com/in/sam" })]);
  });

  it("refuses a file that isn't the export, and keeps what it had", async () => {
    await importConnections(EXPORT(["Sam,Beispiel,,,Hays,Recruiter,05 Nov 2024"]));
    await expect(importConnections("name,company\nSam,Acme")).rejects.toThrow(NetworkError);
    expect(await networkSummary()).toMatchObject({ people: 1 });
  });

  it("answers nothing before an import", async () => {
    expect(await peopleAt(["Hays"])).toEqual({});
  });
});
