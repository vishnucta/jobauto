// Search words in English and the German they go by in postings, for the
// suggested search words (suggestions.ts). Keys are folded (normalText): lower
// case, no accents, one space between words. A word without an entry gets no
// German version rather than a guess. The words are finance, accounting and
// a few common roles; add more as they are needed, and have a German reader
// look over what is added. A word that reads the same in German (EMIR, MiFIR,
// COREP, Controller) needs no entry: it is not offered twice.

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
  "regulatory reporting analyst": "Analyst Meldewesen",
  "risk analyst": "Risikoanalyst",
  "tax advisor": "Steuerberater",
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
  taxation: "Steuerwesen",
  "transaction reporting": "Transaktionsmeldung",
  "regulatory transaction reporting": "Transaktionsmeldung",
  "financial reporting": "Finanzberichterstattung",
  "financial analysis": "Finanzanalyse",
  "financial planning": "Finanzplanung",
  budgeting: "Budgetierung",
  consolidation: "Konsolidierung",
  "general ledger": "Hauptbuchhaltung",
  "month end close": "Monatsabschluss",
  "internal audit": "Interne Revision",
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
