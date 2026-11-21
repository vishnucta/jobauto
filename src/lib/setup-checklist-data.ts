import "server-only";

import { agentSetupProblem } from "@/lib/agent/run";
import { prisma } from "@/lib/prisma";
import { loadSettings } from "@/lib/settings-data";

import { setupSteps, type SetupStep } from "./setup-checklist";

/** Start here (setup-checklist.ts), as things stand. */
export async function loadSetupSteps(): Promise<SetupStep[]> {
  const [settings, agentProblem, google, agencies, agenciesWritten, connections, careers, latest] = await Promise.all([
    loadSettings(),
    agentSetupProblem(),
    prisma.googleAccount.count(),
    prisma.recruiter.count({ where: { kind: "AGENCY" } }),
    prisma.recruiter.count({ where: { kind: "AGENCY", status: { not: "NOT_CONTACTED" } } }),
    prisma.connection.count(),
    prisma.employer.count(),
    prisma.application.findFirst({ where: { awaitingReview: false }, orderBy: { updatedAt: "desc" }, select: { id: true } }),
  ]);
  const answers = settings.applyAnswers;
  return setupSteps({
    agentRunning: settings.agentEnabled && agentProblem === null,
    weeklyTarget: settings.weeklyTarget,
    googleConnected: google > 0,
    agencies,
    agenciesWritten,
    readinessAnswered: answers.confirmed !== false && Boolean(answers.germanCourse.trim() && answers.degreeRecognition.trim() && answers.mobility.trim()),
    answersApplicationId: latest?.id ?? null,
    networkImported: connections > 0,
    phoneAlerts: Boolean(settings.alertAddress),
    careersFollowed: careers,
  });
}
