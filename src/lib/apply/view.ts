import type { ApplyAttemptStatus } from "@/generated/prisma/enums";

import type { ApplyAnswers } from "./answers";
import type { Filled, UnfilledList } from "./run-types";

// What the Apply tab shows (Phase A). Shared with the browser, so nothing
// here reads the database.

export type ApplyPlanView =
  | { kind: "web"; url: string; host: string; atsLabel: string; account: boolean; autoSubmitOk: boolean; board: boolean }
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
};

/** The statuses that mean a run is still going, one way or another. */
export const OPEN_ATTEMPT_STATUSES: readonly ApplyAttemptStatus[] = ["OPENING", "WAITING"];
