// Employers in her field (jobauto fork): where regulatory and transaction
// reporting (EMIR, MiFIR, COREP), reconciliation and fund operations are
// done in Germany, for the Careers pages screen to offer while her profile
// is in that field (hidden-titles.ts REPORTING_PROFILE). Each careers page
// was checked to answer; the ones with a feed the careers check reads can be
// followed in one click, the others opened, or searched for on Positions.
// Checked November 2026: addresses move, so a dead one is simply dropped.

export type FieldEmployer = {
  name: string;
  /** Where in Germany, for the list. */
  cities: string;
  /** What she'd do there, in a line. */
  why: string;
  /** Their careers page, to open. */
  careersUrl: string;
  /** A feed the careers check reads (boards.ts): then it can be followed. */
  followUrl?: string;
};

export const FIELD_EMPLOYERS: readonly FieldEmployer[] = [
  // Hamburg
  { name: "Hamburger Sparkasse", cities: "Hamburg", why: "Its Meldewesen team does much of the bank's supervisory reporting.", careersUrl: "https://www.haspa.de/karriere" },
  { name: "Hanseatic Bank", cities: "Hamburg", why: "Hires Meldewesen specialists for banking-supervisory reporting.", careersUrl: "https://www.hanseaticbank.de/karriere" },
  { name: "Berenberg", cities: "Hamburg, Frankfurt", why: "Investment bank and broker: transaction reporting, operations, reconciliations.", careersUrl: "https://careers.berenberg.com/de" },
  { name: "M.M.Warburg", cities: "Hamburg", why: "Private bank with its own fund company: operations and reporting.", careersUrl: "https://www.mmwarburg.de/de/karriere/" },
  // Frankfurt
  {
    name: "Deutsche Bank",
    cities: "Frankfurt, Berlin",
    why: "Large regulatory reporting and operations teams.",
    careersUrl: "https://careers.db.com",
    followUrl: "https://db.wd3.myworkdayjobs.com/DBWebsite",
  },
  { name: "Commerzbank", cities: "Frankfurt", why: "Meldewesen and finance reporting.", careersUrl: "https://jobs.commerzbank.com" },
  { name: "DZ BANK", cities: "Frankfurt", why: "Central bank of the cooperative banks: regulatory reporting.", careersUrl: "https://www.dzbank.de/content/dzbank/de/home/karriere.html" },
  { name: "Helaba", cities: "Frankfurt", why: "Landesbank: regulatory reporting and finance.", careersUrl: "https://www.helaba.com/de/karriere" },
  { name: "DekaBank", cities: "Frankfurt", why: "The savings banks' asset manager: fund reporting and Meldewesen.", careersUrl: "https://karriere.deka.de", followUrl: "https://karriere.deka.de/services/rss/job/?locale=de_DE" },
  { name: "Deutsche Börse Group", cities: "Frankfurt, Eschborn", why: "Runs Eurex and Clearstream: trade reporting and client asset operations.", careersUrl: "https://careers.deutsche-boerse.com" },
  { name: "Citi", cities: "Frankfurt", why: "Regulatory reporting for its German entities, to the ECB, Bundesbank and BaFin.", careersUrl: "https://jobs.citi.com" },
  { name: "Goldman Sachs Bank Europe", cities: "Frankfurt", why: "Regulatory reporting controllers for its German entities.", careersUrl: "https://higher.gs.com" },
  { name: "J.P. Morgan SE", cities: "Frankfurt", why: "Its EU bank since Brexit: regulatory reporting and operations.", careersUrl: "https://www.jpmorganchase.com/careers" },
  { name: "Universal Investment", cities: "Frankfurt", why: "Fund administration platform (KVG): fund and regulatory reporting.", careersUrl: "https://www.universal-investment.com/de/unternehmen/karriere/" },
  { name: "Union Investment", cities: "Frankfurt", why: "Fund company: fund reporting and operations.", careersUrl: "https://karriere.union-investment.de/" },
  { name: "BNY", cities: "Frankfurt", why: "Custody and fund services: reconciliations and client asset reporting.", careersUrl: "https://www.bny.com/corporate/global/en/about-us/careers/work-with-us.html" },
  // Munich
  { name: "State Street Bank International", cities: "Munich, Frankfurt", why: "Custody and fund administration: reconciliation, client assets, reporting.", careersUrl: "https://careers.statestreet.com/global/en" },
  { name: "Allianz Global Investors", cities: "Frankfurt, Munich", why: "Asset manager: fund and regulatory reporting.", careersUrl: "https://careers.allianz.com/global/en" },
  // Berlin fintechs, whose feeds can be followed
  { name: "Raisin", cities: "Berlin, Hamburg", why: "Savings and investment platform: regulatory reporting and operations.", careersUrl: "https://boards.greenhouse.io/raisin", followUrl: "https://boards.greenhouse.io/raisin" },
  { name: "Trade Republic", cities: "Berlin", why: "Broker and bank: MiFIR transaction reporting and operations.", careersUrl: "https://boards.greenhouse.io/traderepublicbank", followUrl: "https://boards.greenhouse.io/traderepublicbank" },
  { name: "Solaris", cities: "Berlin, Frankfurt", why: "Banking platform: regulatory reporting specialists.", careersUrl: "https://job-boards.greenhouse.io/solarisbank", followUrl: "https://boards.greenhouse.io/solarisbank" },
  { name: "Upvest", cities: "Berlin", why: "Investment infrastructure: brokerage operations and financial crime.", careersUrl: "https://jobs.ashbyhq.com/upvest", followUrl: "https://jobs.ashbyhq.com/upvest" },
  // Software and advisory: reporting experience counts here too
  { name: "Regnology", cities: "Frankfurt, Munich", why: "Makes the reporting software banks use (COREP, FINREP): implementation and analyst roles.", careersUrl: "https://www.regnology.net/en/careers/" },
  { name: "EY Germany", cities: "Frankfurt, Hamburg", why: "Financial services regulatory and tax reporting advisory.", careersUrl: "https://www.ey.com/de_de/careers" },
  { name: "PwC Germany", cities: "Frankfurt, Hamburg", why: "Regulatory reporting advisory for banks and funds.", careersUrl: "https://jobs.pwc.de/de/en" },
  { name: "KPMG Germany", cities: "Frankfurt, Hamburg", why: "Regulatory reporting advisory for banks and funds.", careersUrl: "https://karriere.kpmg.de/", followUrl: "https://jobs.kpmg.de/services/rss/job/?locale=de_DE" },
  { name: "Deloitte Germany", cities: "Frankfurt, Hamburg", why: "Regulatory reporting advisory for banks and funds.", careersUrl: "https://job.deloitte.com/" },
];

/**
 * What a field employer is followed for: the titles her kind of work goes
 * by, not the profile's search words, whose "Financial Analyst" floods a
 * big bank's feed. The broadest come first, as feeds searched word by word
 * (Workday, SuccessFactors) are asked for the first few; every word still
 * picks titles from what they find. They can be changed on Careers pages.
 */
export const FIELD_WORDS = "Regulatory Reporting, Transaction Reporting, Meldewesen, Reconciliation, Abstimmung, Trade Reporting, EMIR, MiFIR, COREP";

/** Places a followed feed is narrowed to: a big employer's feed is worldwide. */
export const GERMAN_PLACES = "Germany, Deutschland, Hamburg, Frankfurt, Eschborn, Berlin, München, Munich, Düsseldorf, Köln, Stuttgart, Remote";

/** The Positions search for an employer: its name and her field's words, in Germany. */
export const fieldSearchHref = (employer: Pick<FieldEmployer, "name">) => `/jobs?${new URLSearchParams({ q: `${employer.name} Regulatory Reporting`, country: "de" })}`;
