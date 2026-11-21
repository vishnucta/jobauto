import { describe, expect, it } from "vitest";

import { companyKey, knownLine, parseConnections, sameCompany } from "./network";

// The shape of LinkedIn's Connections.csv, with made-up people.
const EXPORT = `Notes:
"When exporting your connection data, you may notice that some of the email addresses are missing."

First Name,Last Name,URL,Email Address,Company,Position,Connected On
Sam,Beispiel,https://www.linkedin.com/in/sam-beispiel,,"Berenberg Bank GmbH & Co. KG",Head of Regulatory Reporting,05 Nov 2024
Alex,Muster,https://www.linkedin.com/in/alex-muster,,Hays,Senior Recruiter,12 Jan 2023
Kim,Ohnefirma,https://www.linkedin.com/in/kim,,,,01 Feb 2022
`;

describe("parseConnections", () => {
  it("reads LinkedIn's export after its notes, with each company folded for matching", () => {
    const rows = parseConnections(EXPORT)!;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      firstName: "Sam",
      lastName: "Beispiel",
      company: "Berenberg Bank GmbH & Co. KG",
      position: "Head of Regulatory Reporting",
      url: "https://www.linkedin.com/in/sam-beispiel",
      connectedOn: new Date("2024-11-05T00:00:00Z"),
      companyKey: "berenberg bank",
    });
  });

  it("keeps a person listed twice once", () => {
    const jo = "Jo,Ohnelink,,,Hays,Recruiter,01 Mar 2023";
    const twice = [EXPORT.trimEnd(), "Sam,Beispiel,https://www.linkedin.com/in/sam-beispiel,,Berenberg,Head of Regulatory Reporting,05 Nov 2024", jo, jo].join("\n");
    expect(parseConnections(twice)!.map((row) => row.firstName)).toEqual(["Sam", "Alex", "Jo"]);
  });

  it("says when a file isn't that export", () => {
    expect(parseConnections("name,company\nSam,Acme")).toBeNull();
  });
});

describe("matching employers", () => {
  it("folds legal forms and filler away", () => {
    expect(companyKey("Hauck Aufhäuser Lampe Privatbank AG")).toBe("hauck aufhauser lampe privatbank");
    expect(companyKey("Hays Professional Solutions GmbH")).toBe("hays professional solutions");
  });

  it("matches the same employer under a longer or shorter name, but not short fragments", () => {
    expect(sameCompany(companyKey("Berenberg"), companyKey("Joh. Berenberg, Gossler & Co. KG"))).toBe(true);
    expect(sameCompany(companyKey("Hays"), companyKey("Hays Professional Solutions GmbH"))).toBe(true);
    expect(sameCompany(companyKey("SAP SE"), companyKey("SAP Fioneer"))).toBe(false);
    expect(sameCompany(companyKey("Allianz"), companyKey("Allianz Global Investors"))).toBe(true);
    expect(sameCompany(companyKey("Commerzbank"), companyKey("Deutsche Bank"))).toBe(false);
  });

  it("names the people she knows at a company in a line", () => {
    const sam = { id: "1", name: "Sam Beispiel", position: "Head of Regulatory Reporting", company: "Berenberg", url: "" };
    expect(knownLine([sam])).toBe("Sam Beispiel (Head of Regulatory Reporting)");
    expect(knownLine([sam, { ...sam, id: "2" }, { ...sam, id: "3" }])).toBe("Sam Beispiel (Head of Regulatory Reporting) and 2 more");
  });
});
