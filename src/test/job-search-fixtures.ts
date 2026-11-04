// Answers from job sources for the tests (E14), in each source's own shape,
// with made-up companies and people.

const ledgerly = {
  job_id: "aG9tZWQtZGVzaWduZXItbGVkZ2VybHk=",
  job_title: "Senior Product Designer, Payments",
  employer_name: "Ledgerly",
  employer_logo: "https://example.com/ledgerly.png",
  job_publisher: "LinkedIn",
  job_employment_type: "Full-time",
  job_apply_link: "https://www.linkedin.com/jobs/view/1234567890?utm_source=google_jobs_apply",
  job_apply_is_direct: false,
  apply_options: [
    { publisher: "LinkedIn", apply_link: "https://www.linkedin.com/jobs/view/1234567890?utm_source=google_jobs_apply", is_direct: false },
    { publisher: "Ledgerly Careers", apply_link: "https://careers.ledgerly.example/jobs/42", is_direct: true },
  ],
  job_description: "Ledgerly is hiring a Senior Product Designer for its payments team.\n\nYou'll design checkout flows.\n\n• 5+ years of product design\n• Figma",
  job_is_remote: false,
  job_posted_at_datetime_utc: "2026-09-30T08:00:00.000Z",
  job_posted_at_timestamp: 1790755200,
  // As JSearch writes it: in the country's language, with the publisher.
  job_location: "Hamburg     •  über LinkedIn",
  job_city: null,
  job_state: null,
  job_country: "DE",
  job_latitude: 53.55,
  job_longitude: 9.99,
  job_min_salary: 75000,
  job_max_salary: 90000,
  job_salary_currency: "EUR",
  job_salary_period: "YEAR",
  job_google_link: "https://www.google.com/search?q=jobs&ibp=htl;jobs#htidocid=abc",
};

const northwind = {
  job_id: "bm9ydGh3aW5kLXV4LXJlc2VhcmNo",
  job_title: "UX Researcher",
  employer_name: "Northwind Studio",
  job_publisher: "Indeed",
  job_apply_link: "https://de.indeed.com/viewjob?jk=abc123&from=serp",
  apply_options: [{ publisher: "Indeed", apply_link: "https://de.indeed.com/viewjob?jk=abc123&from=serp", is_direct: false }],
  job_description: "Northwind Studio is looking for a UX Researcher, fully remote within Germany.",
  job_is_remote: true,
  job_posted_at_datetime_utc: null,
  job_posted_at_timestamp: 1790582400,
  job_location: null,
  job_city: "Berlin",
  job_state: null,
  job_country: "DE",
  job_min_salary: null,
  job_max_salary: null,
  job_salary_currency: null,
  job_salary_period: null,
};

/** OpenWeb Ninja's search-v2: jobs and the next page's cursor under `data`. */
export const jsearchV2Page = {
  status: "OK",
  request_id: "c8f1b2a4-0000-4000-8000-000000000001",
  parameters: { query: "product designer in Hamburg", country: "de" },
  data: {
    jobs: [
      ledgerly,
      northwind,
      // Repeated across publishers: kept once.
      ledgerly,
      // Without an id: skipped.
      { job_title: "No id" },
    ],
    cursor: "CURSOR-PAGE-2",
  },
};

/** The last search-v2 page: no cursor. */
export const jsearchV2LastPage = { status: "OK", request_id: "r2", parameters: {}, data: { jobs: [northwind], cursor: null } };

/** What JSearch says to a key it doesn't know. */
export const jsearchKeyError = { status: "ERROR", request_id: "r4", error: { message: "Invalid API key", code: 401 } };

/** Adzuna's search, as its docs describe it: a snippet with HTML, the company and place as objects. */
export const adzunaPage = {
  __CLASS__: "Adzuna::API::Response::JobSearchResults",
  count: 45,
  mean: 61000,
  results: [
    {
      __CLASS__: "Adzuna::API::Response::Job",
      id: "4721394012",
      adref: "eyJhbGciOiJIUzI1NiJ9",
      title: "Senior <strong>Product Designer</strong> &amp; Researcher",
      description: "Ledgerly is hiring a <strong>Product Designer</strong> for its payments team…",
      created: "2026-09-29T09:15:00Z",
      redirect_url: "https://www.adzuna.de/land/ad/4721394012?se=abc&utm_medium=api&utm_source=dossier&v=1",
      company: { __CLASS__: "Adzuna::API::Response::Company", display_name: "Ledgerly GmbH" },
      location: { __CLASS__: "Adzuna::API::Response::Location", display_name: "Hamburg, Deutschland", area: ["Deutschland", "Hamburg"] },
      salary_min: 70000,
      salary_max: 85000,
      salary_is_predicted: "1",
      contract_time: "full_time",
      category: { label: "IT-Stellen", tag: "it-jobs" },
      latitude: 53.55,
      longitude: 9.99,
    },
    {
      id: 4721394013,
      title: "UX Researcher",
      description: null,
      created: "not a date",
      redirect_url: "javascript:alert(1)",
      company: null,
      location: { display_name: "Berlin" },
    },
    // Without an id: skipped.
    { title: "No id" },
  ],
};

/** Jooble's answer to a search: a snippet with the board's markup, and a last-changed time with seven fractional digits and no zone (names made up). */
export const joobleResponse = {
  totalCount: 45,
  jobs: [
    {
      title: "Senior <b>Financial Analyst</b> (m/w/d)",
      location: "Hamburg",
      snippet: "Ledgerly is hiring a <b>Financial Analyst</b> for regulatory reporting&nbsp;... EMIR and MiFIR",
      salary: "65.000 - 80.000 EUR",
      source: "stepstone.de",
      type: "Vollzeit",
      link: "https://jooble.org/jdp/2564425438897072736",
      company: "Ledgerly GmbH",
      updated: "2026-11-02T09:15:00.1230000",
      // As JSON.parse leaves a 19-digit id: rounded. The link has it exactly.
      id: JSON.parse("2564425438897072736") as number,
    },
    {
      title: "Meldewesen Spezialist",
      location: "Frankfurt am Main",
      snippet: null,
      salary: "",
      source: "jooble",
      type: "",
      link: "javascript:alert(1)",
      company: null,
      updated: "not a date",
      id: "88",
    },
    // The same posting twice: kept once.
    { title: "Duplicate", link: "https://jooble.org/jdp/2564425438897072736", id: JSON.parse("2564425438897072736") as number },
    // Without an id: skipped.
    { title: "No id" },
  ],
};

/** The Arbeitsagentur's v6 search, as it answered on 3 October 2026 (company and address made up). */
export const arbeitsagenturPage = {
  ergebnisliste: [
    {
      stellenangebotsart: "ARBEIT",
      stellenangebotsTitel: "Softwareentwickler (m/w/d)",
      arbeitszeitVollzeit: true,
      stellenlokationen: [
        { adresse: { strasse: "Hafenstraße", plz: "20457", ort: "Hamburg", region: "HAMBURG", land: "DEUTSCHLAND" }, breite: 53.54, laenge: 10.0 },
        { adresse: { plz: "23552", ort: "Lübeck", region: "SCHLESWIG_HOLSTEIN", land: "DEUTSCHLAND" } },
        { adresse: { ort: "Hamburg" } },
      ],
      homeofficemoeglich: true,
      homeofficetyp: "ANGABE_IN_PROZENT",
      homeofficeprozent: 60,
      datumErsteVeroeffentlichung: "2026-09-28",
      firma: "Hafenlogik GmbH",
      referenznummer: "10001-1003486534-S",
      entfernung: 3,
      gehaltsspanneVon: 55000,
      gehaltsspanneBis: 68000,
    },
    {
      stellenangebotsTitel: "Remote Backend Developer",
      stellenlokationen: [],
      homeofficeprozent: 100,
      firma: "Nordlicht Software",
      referenznummer: "12265-0000912345-S",
      externeURL: "https://karriere.nordlicht.example/jobs/7",
      datumErsteVeroeffentlichung: null,
    },
    // Without a reference number: skipped.
    { stellenangebotsTitel: "No reference" },
  ],
  maxErgebnisse: 60,
  page: 1,
  size: 25,
  woOutput: { suchmittelpunkt: { lat: 53.55, lon: 9.99 } },
  facetten: {},
};

/** The Arbeitsagentur's v4 job details: the description in light Markdown. */
export const arbeitsagenturDetails = {
  stellenangebotsTitel: "Softwareentwickler (m/w/d)",
  stellenangebotsBeschreibung: "**Wer wir sind**\r\nHafenlogik baut Software für den Hafen.\r\n\r\n\r\n**Was du machst**\n- APIs bauen\n- Tests schreiben",
  referenznummer: "10001-1003486534-S",
};

/** A SerpApi job_id: base64 JSON around Google's own id for the posting, with a long token after it. */
const serpapiJobId = (docId: string) => btoa(JSON.stringify({ job_title: "Senior Product Designer, Payments", htidocid: docId, fc: "f".repeat(600) }));

/** SerpApi's google_jobs engine: the posting's whole text, its age in words, and the apply links by site. */
const ledgerlyOnGoogle = {
  title: "Senior Product Designer, Payments",
  company_name: "Ledgerly",
  location: "Hamburg, Germany",
  via: "LinkedIn",
  share_link: "https://www.google.com/search?ibp=htl;jobs&q=product+designer+in+Hamburg#htivrt=jobs&htidocid=LEDGERLY-42",
  thumbnail: "https://example.com/ledgerly.png",
  extensions: ["4 days ago", "Full-time"],
  detected_extensions: { posted_at: "4 days ago", schedule_type: "Full-time", salary: "75K–90K a year" },
  description: "Ledgerly is hiring a Senior Product Designer for its payments team.\n\nYou'll design checkout flows.\n\n• 5+ years of product design\n• Figma",
  job_highlights: [{ title: "Qualifications", items: ["5+ years of product design", "Figma"] }],
  apply_options: [
    { title: "LinkedIn", link: "https://www.linkedin.com/jobs/view/1234567890?utm_source=google_jobs_apply" },
    { title: "Ledgerly Careers", link: "https://careers.ledgerly.example/jobs/42" },
  ],
  job_id: serpapiJobId("LEDGERLY-42"),
};

const northwindOnGoogle = {
  title: "UX Researcher",
  company_name: "Northwind Studio",
  location: "Anywhere",
  via: "via Indeed",
  share_link: "https://www.google.com/search?ibp=htl;jobs#htivrt=jobs&htidocid=NORTHWIND-7",
  extensions: ["2 hours ago", "Work from home", "Full-time"],
  detected_extensions: { posted_at: "2 hours ago", schedule_type: "Full-time", work_from_home: true },
  description: "Northwind Studio is looking for a UX Researcher, fully remote within Germany.",
  apply_options: [{ title: "Indeed", link: "https://de.indeed.com/viewjob?jk=abc123&from=serp" }],
  // Not every job_id decodes: this one is kept by its hash.
  job_id: "not-base64-json",
};

/** SerpApi's search.json for google_jobs: the jobs, and a token for the next page. */
export const serpapiPage = {
  search_metadata: { id: "serp-1", status: "Success" },
  search_parameters: { engine: "google_jobs", q: "product designer in Hamburg", gl: "de", hl: "en" },
  jobs_results: [
    ledgerlyOnGoogle,
    northwindOnGoogle,
    // Repeated across sites: kept once.
    ledgerlyOnGoogle,
    // Without an id: skipped.
    { title: "No id" },
  ],
  serpapi_pagination: { next_page_token: "TOKEN-PAGE-2", next: "https://serpapi.com/search.json?engine=google_jobs&next_page_token=TOKEN-PAGE-2" },
};

/** The last page: no pagination at all. */
export const serpapiLastPage = { search_metadata: { id: "serp-2", status: "Success" }, jobs_results: [northwindOnGoogle] };

/** Nothing found: a 200 with an error, as SerpApi answers it. */
export const serpapiNoResults = {
  search_metadata: { id: "serp-3", status: "Success" },
  search_information: { jobs_results_state: "Fully empty" },
  error: "Google hasn't returned any results for this query.",
};

/** What SerpApi says to a key it doesn't know, with a 401. */
export const serpapiKeyError = { error: "Invalid API key. Your API key should be here: https://serpapi.com/manage-api-key" };
