import { afterEach, describe, expect, it, vi } from "vitest";

import { placeOf } from "../place";
import { matchStartup } from "../match";
import { cityFromAddress, decodeMixed, ESMA_UPREG, fetchLicensedFirms, firmFromCasp, firmFromRegister, MICA_CASPS_CSV, parseCsv } from "./licences";

vi.mock("@/lib/env", () => ({ env: {} }));

afterEach(() => vi.unstubAllGlobals());

const now = new Date("2026-11-14T10:00:00Z");

const HEADER = "ae_competentAuthority,ae_homeMemberState,ae_lei_name,ae_lei,ae_lei_cou_code,ae_commercial_name,ae_address,ae_website,ae_website_platform,ac_authorisationNotificationDate,ac_authorisationEndDate,ac_serviceCode,ac_serviceCode_cou,ac_comments,ac_lastupdate,ac_legal_basis,";
const casp = (fields: Partial<Record<string, string>> = {}) => ({
  ae_competentAuthority: "Bundesanstalt für Finanzdienstleistungsaufsicht (BaFin)",
  ae_homeMemberState: "DE",
  ae_lei_name: "Elbe Digital Assets GmbH",
  ae_lei: "529900ELBE0000000001",
  ae_commercial_name: "Elbe",
  ae_address: "Ballindamm 1, 20095 Hamburg",
  ae_website: "www.elbe-digital.example",
  ac_authorisationNotificationDate: "19/09/2026",
  ac_authorisationEndDate: "",
  ac_serviceCode: "a. providing custody and administration of crypto-assets on behalf of clients | c. exchange of crypto-assets for funds",
  ac_legal_basis: "Article 63 - CASP authorisation",
  ...fields,
});

describe("reading the MiCA file", () => {
  it("reads quoted fields with commas, and lines that carry Latin-1 bytes", () => {
    const latin = new Uint8Array([...new TextEncoder().encode('X,"Lindenstra'), 0xdf, ...new TextEncoder().encode('e 53, M'), 0xfc, ...new TextEncoder().encode('nchen"\n')]);
    const utf8 = new TextEncoder().encode("﻿name,address\n");
    const text = decodeMixed(new Uint8Array([...utf8, ...latin]));
    expect(parseCsv(text)).toEqual([{ name: "X", address: "Lindenstraße 53, München" }]);
  });

  it("keeps crypto-asset providers newly authorised in Germany, and leaves out notifications, older ones and other countries", () => {
    expect(firmFromCasp(casp(), now)).toMatchObject({
      source: "LICENCE",
      externalId: "mica:529900ELBE0000000001",
      company: "Elbe Digital Assets GmbH",
      website: "https://www.elbe-digital.example",
      summary: "New crypto-asset service provider, authorised under MiCA on 19 Sept 2026",
      location: "Hamburg, Germany",
      stage: "Crypto-asset provider (MiCA)",
      postedAt: "2026-09-19T00:00:00.000Z",
    });
    expect(firmFromCasp(casp(), now)!.details).toContain("Services: providing custody and administration of crypto-assets on behalf of clients; exchange of crypto-assets for funds.");
    expect(firmFromCasp(casp(), now)!.details).toContain("Initiativbewerbung");
    expect(firmFromCasp(casp({ ac_legal_basis: "Article 60 - Notification", ae_lei_name: "Volksbank Beispiel eG" }), now)).toBeNull();
    expect(firmFromCasp(casp({ ac_authorisationNotificationDate: "01/09/2025" }), now)).toBeNull();
    expect(firmFromCasp(casp({ ae_homeMemberState: "AT" }), now)).toBeNull();
    expect(firmFromCasp(casp({ ac_authorisationEndDate: "01/11/2026" }), now)).toBeNull();
  });
});

describe("reading the investment firm register", () => {
  const firm = (fields: Partial<Record<string, string>> = {}) => ({
    id: "ae100",
    ae_entityName: "Xervices GmbH",
    ae_commercialName: "",
    ae_officeType: "Head office",
    ae_homeMemberState: "GERMANY",
    ae_hostMemberState: "",
    ae_headOfficeAddress: "Große Gallusstr. 16-18,60312,Frankfurt am Main,DE",
    ae_branchAddress: "",
    ae_competentAuthority: "Bundesanstalt für Finanzdienstleistungsaufsicht (BaFin)",
    ae_authorisationNotificationDate: "2026-09-30T00:00:00Z",
    ae_website: "",
    ae_status: "Active",
    ...fields,
  });

  it("keeps new German investment firms and new German branches of EU firms", () => {
    expect(firmFromRegister(firm())).toMatchObject({ externalId: "mifid:ae100", summary: "New investment firm, authorised by BaFin on 30 Sept 2026", location: "Frankfurt am Main, Germany", stage: "Investment firm" });
    const branch = firmFromRegister(firm({ ae_entityName: "Marex SA, Zweigniederlassung Deutschland", ae_officeType: "Branch", ae_homeMemberState: "FRANCE", ae_hostMemberState: "GERMANY", ae_branchAddress: "Bockenheimer Landstraße 2, 60323 Frankfurt am Main", ae_competentAuthority: "AMF" }));
    expect(branch).toMatchObject({ stage: "Branch in Germany", location: "Frankfurt am Main, Germany" });
    expect(branch!.details).toContain("supervised by AMF");
  });

  it("leaves out shelf companies, closed firms and German firms' branches abroad", () => {
    expect(firmFromRegister(firm({ ae_entityName: "DONNER & REUSCHEL Vorratsgesellschaft mbH" }))).toBeNull();
    expect(firmFromRegister(firm({ ae_status: "Withdrawn" }))).toBeNull();
    expect(firmFromRegister(firm({ ae_officeType: "Branch", ae_hostMemberState: "SWEDEN" }))).toBeNull();
  });

  it("finds the city in either way of writing an address", () => {
    expect(cityFromAddress("Bockenheimer Anlage 46, 60322 Frankfurt am Main")).toBe("Frankfurt am Main, Germany");
    expect(cityFromAddress("Ballindamm 27,20095,Hamburg,DE")).toBe("Hamburg, Germany");
    expect(cityFromAddress("Poststraße 20 20354 Hamburg GERMANY")).toBe("Hamburg, Germany");
    expect(cityFromAddress("")).toBe("Germany");
  });
});

describe("fetchLicensedFirms", () => {
  it("asks both registers and keeps one's firms when the other fails", async () => {
    const asked: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        asked.push(url);
        if (url === MICA_CASPS_CSV) {
          const row = casp();
          const line = HEADER.split(",").map((name) => `"${row[name as keyof typeof row] ?? ""}"`).join(",");
          return new Response(`﻿${HEADER}\n${line}\n`);
        }
        return new Response("", { status: 503 });
      }),
    );
    const firms = await fetchLicensedFirms(new AbortController().signal, now);
    expect(firms.map((found) => found.company)).toEqual(["Elbe Digital Assets GmbH"]);
    const queries = asked.filter((url) => url.startsWith(ESMA_UPREG)).map((url) => new URL(url).searchParams.get("q"));
    expect(queries).toHaveLength(2);
    expect(queries[0]).toContain("ae_homeMemberState:GERMANY");
    expect(queries[1]).toContain("ae_hostMemberState:GERMANY AND ae_officeType:Branch");
  });
});

describe("how a newly licensed firm fits", () => {
  const hamburg = placeOf({ city: "Hamburg", country: "Germany" });
  const reporting = { basics: { headline: "Financial Analyst, regulatory reporting", summary: "EMIR and MiFIR transaction reporting", city: "Hamburg", country: "Germany" }, skills: [], experience: [] };

  it("fits a regulatory reporting profile best, the newer and nearer the better", () => {
    const fit = matchStartup(firmFromCasp(casp(), now)!, reporting as never, hamburg, now);
    expect(fit.reasons).toEqual(["Has MiCA and transaction reporting to set up, which you've done", "Licensed 56 days ago", "In Hamburg"]);
    expect(fit.score).toBe(95);
    const elsewhere = matchStartup(firmFromRegister({ ...firmFromCasp(casp(), now), id: "x", ae_entityName: "Xervices GmbH", ae_commercialName: "", ae_officeType: "Head office", ae_homeMemberState: "GERMANY", ae_hostMemberState: "", ae_headOfficeAddress: "Große Gallusstr. 16,60312,Frankfurt am Main,DE", ae_branchAddress: "", ae_competentAuthority: "BaFin", ae_authorisationNotificationDate: "2026-03-01T00:00:00Z", ae_website: "", ae_status: "Active" })!, reporting as never, hamburg, now);
    expect(elsewhere.reasons).toEqual(["Has MiFIR transaction reporting to set up, which you've done", "In Germany"]);
    expect(elsewhere.score).toBeLessThan(fit.score);
  });
});
