// The named steps of an apply run, as the Apply tab shows them while the
// browser works (ProgressSteps). Shared with the browser.

export const APPLY_STEPS = [
  "Preparing your PDFs",
  "Opening the employer's page",
  "Finding the application form",
  "Filling in your details",
  "Attaching your PDFs",
  "Handing over to you",
] as const;
export type ApplyStep = (typeof APPLY_STEPS)[number];
