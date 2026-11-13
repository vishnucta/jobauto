import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { after } from "next/server";

import { countAgentQueue } from "@/lib/agent/view";
import { checkAnnouncementsIfDue } from "@/lib/announcements/check";
import { currentAnnouncement } from "@/lib/announcements/visible";
import { verifySession } from "@/lib/auth/session";
import { isDesktopApp } from "@/lib/desktop";
import { inboxCount } from "@/lib/google/inbox-data";
import { loadProfileName } from "@/lib/profile-data";
import { prisma } from "@/lib/prisma";
import { loadSettings } from "@/lib/settings-data";
import { opensSetupGuide } from "@/lib/setup-guide";
import { COLOR_SCHEME_COOKIE, parseColorScheme, parseSidebarCollapsed, SIDEBAR_COOKIE } from "@/lib/ui-preferences";
import { rememberBrowserTimeZone, userTimeZone } from "@/lib/time-zone";
import { checkForUpdatesDaily, updateNotice } from "@/lib/update-check";
import { appVersion } from "@/lib/version";

import { AnnouncementNotice } from "./announcement-notice";
import { Sidebar } from "./sidebar";

/**
 * The signed-in shell: sidebar on the left, the screen on the right. Routes
 * outside the (app) group, such as /login, render without it. Every page
 * inside needs a session.
 */
export default async function AppLayout({ children }: LayoutProps<"/">) {
  // Proxy already redirects signed-out visitors; this is the check next to the data.
  await verifySession();
  // The day's update check, if it hasn't run yet: after the page, so it never slows one down.
  after(checkForUpdatesDaily);
  // The browser's zone, for the inbox check, which runs without a request.
  const zone = await userTimeZone();
  after(() => rememberBrowserTimeZone(zone));

  const [name, settings, jar] = await Promise.all([loadProfileName(), loadSettings(), cookies()]);
  // A fresh install starts with the setup guide, once (E21).
  if (settings.setupGuide === null && opensSetupGuide({ guide: null, name, applications: await prisma.application.count() })) redirect("/welcome");
  // The backend's notices, if it's time to ask (it costs a page nothing until then).
  after(() => checkAnnouncementsIfDue(settings));
  const userName = name.trim() || "New user";
  const announcement = currentAnnouncement(settings);
  // Replies waiting for an answer or a link, on the Inbox item; the job agent's finds and drafts on its own (E16-6).
  const [waiting, agent] = await Promise.all([inboxCount().catch(() => 0), countAgentQueue().catch(() => 0)]);

  return (
    <div className="flex min-h-screen">
      <a
        href="#main"
        className="fixed top-3 left-3 z-50 -translate-y-[200%] rounded-control bg-primary px-4 py-2.5 text-sm font-medium text-on-primary hover:text-on-primary focus:translate-y-0"
      >
        Skip to content
      </a>
      <Sidebar
        userName={userName}
        update={updateNotice(settings)}
        currentVersion={appVersion}
        desktop={isDesktopApp()}
        collapsed={parseSidebarCollapsed(jar.get(SIDEBAR_COOKIE)?.value)}
        counts={{ ...(waiting > 0 ? { "/inbox": waiting } : {}), ...(agent > 0 ? { "/agent": agent } : {}) }}
        colorScheme={parseColorScheme(jar.get(COLOR_SCHEME_COOKIE)?.value)}
      />
      {/* The screen sits in a white panel inset from the shell. Each screen
          starts with its page bar (PageHeader or PageBar), which draws the
          panel's top edge and stays in view. */}
      <div className="flex min-w-0 flex-1 flex-col bg-paper px-2 pb-2">
        <main
          id="main"
          tabIndex={-1}
          className="relative flex min-w-0 flex-1 flex-col rounded-b-panel border border-t-0 border-line-card bg-surface focus:outline-none"
        >
          {children}
        </main>
      </div>
      {/* A new notice starts over, once the one before was dismissed. */}
      {announcement && <AnnouncementNotice key={announcement.id} announcement={announcement} />}
    </div>
  );
}
