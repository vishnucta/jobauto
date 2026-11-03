import { describe, expect, it } from "vitest";

import { DOCUMENT_LANGUAGES, detectDirection, detectLanguageName, documentLanguage, hasRightToLeft } from "./document-language";

describe("documentLanguage", () => {
  it("knows every built-in language (SET-7)", () => {
    expect(DOCUMENT_LANGUAGES).toHaveLength(21);
    expect(documentLanguage("Persian", "")).toEqual({ lang: "fa", dir: "rtl" });
    expect(documentLanguage("arabic", "")).toEqual({ lang: "ar", dir: "rtl" });
    expect(documentLanguage("Chinese (Simplified)", "")).toEqual({ lang: "zh-Hans", dir: "ltr" });
    expect(documentLanguage(" Japanese ", "")).toEqual({ lang: "ja", dir: "ltr" });
  });

  it("writes common right-to-left languages added with “Other language…” right to left", () => {
    expect(documentLanguage("Hebrew", "")).toEqual({ lang: "he", dir: "rtl" });
    expect(documentLanguage("Urdu", "")).toEqual({ lang: "ur", dir: "rtl" });
  });

  it("reads the text when there's no language, or one it doesn't know", () => {
    expect(documentLanguage(null, "سارا احمدی، طراح ارشد محصول")).toEqual({ lang: undefined, dir: "rtl" });
    expect(documentLanguage("Klingon", "佐藤 花子、シニアデザイナー")).toEqual({ lang: "ja", dir: "ltr" });
    expect(documentLanguage(undefined, "김지현 디자이너")).toEqual({ lang: "ko", dir: "ltr" });
    expect(documentLanguage(undefined, "王晓明 资深产品设计师")).toEqual({ lang: "zh-Hans", dir: "ltr" });
    expect(documentLanguage(undefined, "अनन्या शर्मा")).toEqual({ lang: "hi", dir: "ltr" });
    expect(documentLanguage(undefined, "Ελένη Παπαδοπούλου")).toEqual({ lang: "el", dir: "ltr" });
  });

  it("goes by most of the text, not a stray name", () => {
    expect(documentLanguage(undefined, "Designer at 阿里巴巴 and Northwind Logistics")).toEqual({ lang: undefined, dir: "ltr" });
    expect(documentLanguage(undefined, "Jane Doe, designer in Rotterdam")).toEqual({ lang: undefined, dir: "ltr" });
  });
});

describe("text direction", () => {
  it("counts letters, ignoring digits and punctuation", () => {
    expect(detectDirection("ليلى حداد, 2021")).toBe("rtl");
    expect(detectDirection("Jane, ليلى")).toBe("ltr");
    expect(detectDirection("+1 555 010 0000")).toBe("ltr");
  });

  it("spots right-to-left letters", () => {
    expect(hasRightToLeft("تهران, ایران")).toBe(true);
    expect(hasRightToLeft("sample@example.com")).toBe(false);
  });
});

describe("detectLanguageName", () => {
  it("leaves text in another script alone, whatever English words it has", () => {
    const chinese = "负责重新设计运营门户，每天有数千名调度员使用，并建立了整个公司使用的设计系统。 与产品、工程和研究团队合作，端到端交付 A/B testing time to market of the and for with";
    expect(detectLanguageName(chinese)).toBeUndefined();
    const arabic = "قادت إعادة تصميم البوابة التي يستخدمها آلاف المرسلين يوميا وبنت نظام التصميم الذي تستخدمه الشركة كلها مع فرق المنتج والهندسة والبحث time to market and the of for with";
    expect(detectLanguageName(arabic)).toBeUndefined();
  });

  const german =
    "Produktdesignerin mit neun Jahren Erfahrung darin, komplexe Software ruhig und verständlich zu gestalten. Ich habe die Neugestaltung eines Portals geleitet, das täglich von vielen Disponenten genutzt wird, und ein Designsystem für die Teams aufgebaut.";
  const english =
    "Product designer with nine years of experience turning complicated operational tools into calm, usable software. I led the redesign of the carrier portal used daily by thousands of dispatchers and built a design system that the whole company uses.";
  const dutch =
    "Productontwerper met negen jaar ervaring in het rustig en overzichtelijk maken van complexe software. Ik leidde het herontwerp van een portaal dat dagelijks door duizenden planners wordt gebruikt en bouwde een designsysteem dat het hele bedrijf gebruikt.";
  const french =
    "Designer produit avec neuf ans d'expérience dans la conception d'outils complexes, pour les rendre calmes et clairs. J'ai dirigé la refonte du portail utilisé chaque jour par des milliers de répartiteurs et construit un système de design pour toute l'entreprise.";

  it("tells the language of a summary by its little words", () => {
    expect(detectLanguageName(german)).toBe("German");
    expect(detectLanguageName(english)).toBe("English");
    expect(detectLanguageName(dutch)).toBe("Dutch");
    expect(detectLanguageName(french)).toBe("French");
  });

  it("says nothing about a few words, or a text half in each language", () => {
    expect(detectLanguageName("Senior Produktdesignerin")).toBeUndefined();
    expect(detectLanguageName("Figma · User research · Design systems · Prototyping · HTML & CSS")).toBeUndefined();
    expect(
      detectLanguageName(
        "The team built the portal and shipped it to the users in a year. Das Team hat das Portal gebaut und es in einem Jahr an die Nutzer geliefert.",
      ),
    ).toBeUndefined();
  });

  it("names the language as the list spells it", () => {
    expect(DOCUMENT_LANGUAGES.map((language) => language.name)).toContain(detectLanguageName(german));
  });
});
