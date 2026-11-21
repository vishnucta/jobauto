import type { Metadata } from "next";
import { headers } from "next/headers";

import { loadAiConfig, loadAiSettingsView } from "@/lib/ai/config";
import { agentPortalsView } from "@/lib/agent/source";
import { agentPortal, jobSearchView, loadJobSearchConfig } from "@/lib/job-search/config";
import { portalUpdates } from "@/lib/portals/updates";
import { COUNTRIES } from "@/lib/job-search/countries";
import { isDesktopApp } from "@/lib/desktop";
import { loadSearch } from "@/lib/posting-searches";
import { agentPortals } from "@/lib/agent/run";
import { listAgentSearches } from "@/lib/agent/searches";
import { providerOption } from "@/lib/ai/provider-options";
import { listAttachments } from "@/lib/attachments";
import { lastNightlyBackup } from "@/lib/backup-schedule";
import { backupsDir } from "@/lib/backups";
import { mcpUrl } from "@/lib/connector/oauth";
import { exportFileName } from "@/lib/data-export";
import { isSqliteUrl } from "@/lib/database";
import { env } from "@/lib/env";
import { redirectUri } from "@/lib/google/oauth";
import { googleClientView, googleView, requestOrigin, whenRan } from "@/lib/settings-views";
import { lastKnownTimeZone, userTimeZone } from "@/lib/time-zone";
import { appVersion } from "@/lib/version";
import { prisma } from "@/lib/prisma";
import { loadProfile, loadProfileName } from "@/lib/profile-data";
import { searchChips, searchWords } from "@/lib/job-search/suggestions";
import { describeGuide } from "@/lib/salary-guide";
import { loadSalaryGuide } from "@/lib/salary-guide-data";
import { scoringProblem } from "@/lib/scoring";
import { loadScoringConfig, scoringView } from "@/lib/scoring/config";
import { loadScoringOff } from "@/lib/scoring-off-data";
import { portalsOffNote } from "@/lib/job-search/portals-off";
import { coversFromScore } from "@/lib/posting-coverage";
import { agentCoversOf } from "@/lib/settings";
import { loadSettings } from "@/lib/settings-data";
import { loadSettingsStatus } from "@/lib/settings-status-data";
import { availableUpdate } from "@/lib/update-check";

import { AgentSection } from "./agent-section";
import { AnswersSection, type SalaryHint } from "./answers-section";
import { ApplyBrowserCard } from "./apply-browser-card";
import { PortalCatalog } from "./browse-portals";
import { AiBehaviour } from "./ai-behaviour";
import { AiDataFlows } from "./ai-data-flows";
import { AiProviderSection } from "./ai-provider-section";
import { DataSection } from "./data-section";
import { DocumentsSection } from "./documents-section";
import { GoogleSection } from "./google-section";
import { GoogleNotice } from "./google-notice";
import { JobSearchSection } from "./job-search-section";
import { ScoringSection } from "./scoring-section";
import { ScoringOffNotice } from "../scoring-off-notice";
import { AboutSection, type AboutFacts } from "./about-section";
import { ConnectorSection } from "./connector-section";
import { NotificationsSection } from "./notifications-section";
import { settingsSectionFromParam } from "./sections";
import { SettingsOverview } from "./settings-overview";
import { SettingsScreen } from "./settings-screen";
import { listProfiles, openProfileId, profileSearchDefaults } from "@/lib/profiles";
import { listChannels, listDeliveries } from "@/lib/notifications/store";

export const metadata: Metadata = { title: "Settings" };

/** Settings (PRD §6.8); the section is in `?section=` (E10-1), and without one the overview (E34-2). */
export default async function SettingsPage({ searchParams }: PageProps<"/settings">) {
  const params = await searchParams;
  const section = settingsSectionFromParam(params.section);
  const [settings, status, aiView] = await Promise.all([loadSettings(), loadSettingsStatus(), section === "ai" ? loadAiSettingsView() : null]);
  const jobConfig = section === "agent" ? await loadJobSearchConfig() : null;

  return (
    <SettingsScreen
      section={section}
      status={status}
      aside={aiView ? <AiDataFlows initial={{ provider: aiView.provider, baseUrl: aiView.baseUrl }} /> : section === "jobs" ? <PortalCatalog /> : undefined}
    >
      {section === "overview" ? (
        <SettingsOverview status={status} />
      ) : aiView ? (
        <>
          <AiProviderSection initial={aiView} />
          <AiBehaviour initial={{ creativity: settings.creativity, strict: settings.strict, showDiff: settings.showDiff, dailyNoteAi: settings.dailyNoteAi }} />
        </>
      ) : section === "jobs" ? (
        <JobSearchSectionWithNote archiveDays={settings.archiveAfterDays} />
      ) : section === "answers" ? (
        // The answers every application uses (jobauto fork), edited here only.
        <>
          <AnswersSection initial={settings.applyAnswers} salaryGuide={await answersSalaryGuide()} />
          {/* Where the apply assistant's window opens, moved here from the Apply tab (audit round 2). */}
          <ApplyBrowserCard address={settings.applyBrowserAddress} />
        </>
      ) : section === "scoring" ? (
        <ScoringWithNotice />
      ) : section === "agent" ? (
        <AgentSection
          initial={{
            enabled: settings.agentEnabled,
            hour: settings.agentHour,
            covers: agentCoversOf(settings),
            strongCovers: coversFromScore(settings.alertMinScore),
            maxScores: settings.agentMaxScores,
            maxDrafts: settings.agentMaxDrafts,
            autoDraft: settings.agentAutoDraft,
            portals: settings.agentPortals,
          }}
          searches={await listAgentSearches()}
          suggestedQuery={(await loadSearch())?.query}
          profiles={await Promise.all((await listProfiles()).map(async (profile) => ({ ...profile, defaults: await profileSearchDefaults(profile.id) })))}
          source={agentPortal(jobConfig!)}
          sources={agentPortals(jobConfig!, settings.agentPortals)}
          portals={agentPortalsView(jobConfig!, settings.agentPortals)}
          scoring={await scoringReadiness()}
          countries={COUNTRIES}
          timeZone={await lastKnownTimeZone()}
          onlyWhileOpen={isDesktopApp()}
        />
      ) : section === "notifications" ? (
        <NotificationsSection initial={{ channels: await listChannels(), log: await listDeliveries(), supporter: { day: settings.supporterDay, hour: settings.supporterHour } }} />
      ) : section === "google" ? (
        <>
          <GoogleNotice outcome={typeof params.google === "string" ? params.google : null} />
          <GoogleSection
            connection={await googleView()}
            client={await googleClientView()}
            browserTimeZone={(await userTimeZone()) ?? null}
            redirectUri={redirectUri(await requestOrigin())}
            inDesktopApp={isDesktopApp()}
            initial={{
              gmailRead: settings.gmailRead,
              gmailScope: settings.gmailScope,
              gmailInterval: settings.gmailInterval,
              calendarAvailability: settings.calendarAvailability,
              calendarEvents: settings.calendarEvents,
              calendarId: settings.calendarId,
              workDays: settings.workDays,
              workStart: settings.workStart,
              workEnd: settings.workEnd,
              workTimeZone: settings.workTimeZone,
              slotMinutes: settings.slotMinutes,
              bufferMinutes: settings.bufferMinutes,
            }}
          />
        </>
      ) : section === "connector" ? (
        <ConnectorSection
          initial={{ on: settings.connectorEnabledAt !== null, redirects: settings.connectorRedirects }}
          address={mcpUrl(env.DOSSIER_PUBLIC_URL ?? (await requestOrigin()))}
          inDesktopApp={isDesktopApp()}
        />
      ) : section === "data" ? (
        <DataSection
          hasApiKey={[settings.apiKeyEnc, settings.jsearchKeyEnc, settings.serpapiKeyEnc, settings.adzunaKeyEnc, settings.joobleKeyEnc].some((key) => key !== null) || Object.keys(settings.portalKeysEnc).length > 0}
          exportName={exportFileName()}
          backups={{
            on: settings.nightlyBackup,
            retentionDays: env.DOSSIER_BACKUP_RETENTION_DAYS,
            dir: backupsDir(),
            lastRun: whenRan(await lastNightlyBackup()),
            problem: settings.backupProblem,
            onlyWhileOpen: isDesktopApp(),
          }}
          jobRetentionHours={settings.jobRetentionHours}
        />
      ) : section === "documents" ? (
        <DocumentsSection
          // Only these fields: the settings also hold the encrypted API key, which never leaves the server.
          initial={{
            paper: settings.paper,
            dateFormat: settings.dateFormat,
            defaultTone: settings.defaultTone,
            docLanguage: settings.docLanguage,
            customLanguages: settings.customLanguages,
            fileNamePattern: settings.fileNamePattern,
            includeRefs: settings.includeRefs,
            germanOnlyWhenFit: settings.germanOnlyWhenFit,
            documentsToWrite: settings.documentsToWrite,
          }}
          preview={await filePreview()}
          attachments={await listAttachments()}
        />
      ) : (
        <AboutSection
          facts={await aboutFacts()}
          updates={{ daily: settings.updateCheck, available: availableUpdate(settings) }}
        />
      )}
    </SettingsScreen>
  );
}

/** Settings → Job search, with the one-time note about portals with a key that are off (jobauto fork). */
async function JobSearchSectionWithNote({ archiveDays }: { archiveDays: number }) {
  const view = await jobSearchViewWithUpdates();
  return <JobSearchSection initial={view} archiveDays={archiveDays} portalsOffNote={(await portalsOffNote(view.portals)) !== null} />;
}

/** Settings → Scoring, under "Scoring is off" while a profile has no levels (jobauto fork): its card here says so too. */
async function ScoringWithNotice() {
  const [config, off] = await Promise.all([loadScoringConfig(), loadScoringOff()]);
  return <ScoringSection initial={scoringView(config)} notice={off && <ScoringOffNotice off={off} />} />;
}

/** The salary guide beside the salary expectation (jobauto fork): for the open profile's own title, from the postings she has seen. */
async function answersSalaryGuide(): Promise<SalaryHint | null> {
  const profile = await loadProfile(await openProfileId());
  const title = searchChips(searchWords(profile, new Date()), 1)[0] ?? "";
  const guide = await loadSalaryGuide(title);
  return guide ? { title, text: describeGuide(guide, `jobs like “${title}”`) } : null;
}

/** What scores the job agent's postings, and whether it's set up (#274). */
async function scoringReadiness() {
  const config = await loadScoringConfig();
  return { scorer: config.scorer, ready: (await scoringProblem(config)) === null };
}

/** The file name preview uses your name and your latest application, or sample values (SET-8). */
async function filePreview() {
  const [name, latest] = await Promise.all([
    loadProfileName(),
    prisma.application.findFirst({ where: { awaitingReview: false }, orderBy: { createdAt: "desc" }, select: { company: true, role: true } }),
  ]);
  return {
    name: name.trim() || "Jane Doe",
    company: latest?.company.trim() || "Ledgerly",
    role: latest?.role.trim() || "Senior Product Designer",
  };
}

/** "12.4 MB" */
function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
}

/** The About rows (SET-12). */
async function aboutFacts(): Promise<AboutFacts> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host")?.split(",")[0]?.trim() || requestHeaders.get("host") || "Unknown";
  const sqlite = isSqliteUrl(env.DATABASE_URL);
  const [[database], ai, applications] = await Promise.all([
    sqlite
      ? prisma.$queryRaw<{ size: bigint }[]>`SELECT page_count * page_size AS size FROM pragma_page_count(), pragma_page_size()`
      : prisma.$queryRaw<{ size: bigint }[]>`SELECT pg_database_size(current_database()) AS size`,
    loadAiConfig(),
    prisma.application.count({ where: { awaitingReview: false } }),
  ]);
  return [
    { label: "Version", value: appVersion },
    { label: "Server", value: host },
    { label: "Database", value: `${sqlite ? "SQLite" : "PostgreSQL"} · ${formatBytes(Number(database.size))}` },
    { label: "Sign-in", value: isDesktopApp() ? "none, on this computer" : "set via DOSSIER_PASSWORD" },
    { label: "AI", value: [providerOption(ai.provider).name, ai.model].filter(Boolean).join(" · ") },
    { label: "Applications", value: String(applications) },
  ];
}

/** Settings → Job search's portals, each with its update from the catalog (E23-5). */
async function jobSearchViewWithUpdates() {
  const config = await loadJobSearchConfig();
  return jobSearchView(config, await portalUpdates(config));
}
