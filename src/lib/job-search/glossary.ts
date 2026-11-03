// Search words in English and the German they go by in postings, for the
// suggested search words (suggestions.ts). Keys are folded (normalText): lower
// case, no accents, one space between words. A word without an entry gets no
// German version rather than a guess. The words are finance, accounting and
// a few common roles; add more as they are needed, and have a German reader
// look over what is added.

export const GERMAN_WORDS: Readonly<Record<string, string>> = {
  // Roles
  "financial analyst": "Finanzanalyst",
  "credit analyst": "Kreditanalyst",
  "data analyst": "Datenanalyst",
  accountant: "Buchhalter",
  "financial accountant": "Finanzbuchhalter",
  "project manager": "Projektleiter",
  "product manager": "Produktmanager",
  "marketing manager": "Marketingmanager",
  "software engineer": "Softwareentwickler",
  "software developer": "Softwareentwickler",
  // Fields
  "regulatory reporting": "Meldewesen",
  reconciliation: "Kontenabstimmung",
  accounting: "Rechnungswesen",
  bookkeeping: "Buchhaltung",
  "accounts payable": "Kreditorenbuchhaltung",
  "accounts receivable": "Debitorenbuchhaltung",
  payroll: "Lohnabrechnung",
  vat: "Umsatzsteuer",
  "credit analysis": "Kreditanalyse",
  "cost controlling": "Controlling",
  "financial modeling": "Finanzmodellierung",
  "financial modelling": "Finanzmodellierung",
  "financial statements": "Jahresabschluss",
  "data analysis": "Datenanalyse",
  "risk management": "Risikomanagement",
  "project management": "Projektmanagement",
  "human resources": "Personalwesen",
  "customer service": "Kundenservice",
};
