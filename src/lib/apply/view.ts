import type { ApplyAttemptStatus } from "@/generated/prisma/enums";

import type { ApplyAnswers } from "./answers";
import type { FindPosting, LinkOwner } from "./link-owner";
import type { Filled, UnfilledList } from "./run-types";

// What the Apply tab shows (Phase A). Shared with the browser, so nothing
// here reads the database.

export type ApplyPlanView =
  | {
      kind: "web";
      url: string;
      host: string;
      atsLabel: string;
      account: boolean;
      autoSubmitOk: boolean;
      board: boolean;
      /** Whose page the link is (link-owner.ts): a copy of the ad, an agency's site, or unsure; absent for the employer's own or a known system. */
      owner?: LinkOwner | null;
    }
  | { kind: "email"; to: string }
  | { kind: "none" };

export type ApplyAttemptView = {
  id: string;
  status: ApplyAttemptStatus;
  note: string;
  /** "30 Oct, 14:32", in the user's time zone. */
  startedAt: string;
  host: string;
  filled: Filled;
  unfilled: UnfilledList;
  captcha: boolean;
  screenshot: boolean;
  confirmation: boolean;
  autoSubmit: boolean;
  /** The server is still watching its browser tab for the confirmation. */
  watching: boolean;
};

export type ApplyTabData = {
  plan: ApplyPlanView;
  answers: ApplyAnswers;
  /** Newest first. */
  attempts: ApplyAttemptView[];
  /** The apply job still running, e.g. since before a reload. */
  running: string | null;
  /** What it is: a run opening the employer's page, or "Fill this page" on a page the user is at. */
  runningKind: "run" | "page" | null;
  hasResume: boolean;
  hasLetter: boolean;
  /** Profile basics forms usually ask for that are empty, e.g. "phone number". */
  missing: string[];
  /** The laptop's Chrome the window opens in, e.g. "http://100.101.102.103:9222"; null opens it on the computer the app runs on. */
  browserAddress: string | null;
  /** What postings like this one pay, from the ones she has seen (salary-guide.ts); null with too few. Missing in older callers. */
  salaryGuide?: string | null;
  /** Where to look for the employer's own posting, when the link is a copy of the ad or may be one (link-owner.ts); null otherwise. */
  findPosting?: FindPosting | null;
};

/** The statuses that mean a run is still going, one way or another. */
export const OPEN_ATTEMPT_STATUSES: readonly ApplyAttemptStatus[] = ["OPENING", "WAITING"];
