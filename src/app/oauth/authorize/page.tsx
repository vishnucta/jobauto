import type { Metadata } from "next";

import { BrandMark } from "@/components/brand-mark";
import { verifySession } from "@/lib/auth/session";

import { Consent } from "./consent";
import { checkAuthorizeRequest } from "./request";

export const metadata: Metadata = { title: "Connect Claude" };

/**
 * Claude asks to use Dossier through the connector (#221, src/app/api/mcp).
 * Signed-out visitors sign in first: the proxy sends them to /login and back.
 */
export default async function AuthorizePage({ searchParams }: PageProps<"/oauth/authorize">) {
  await verifySession();
  const params = await searchParams;
  const checked = await checkAuthorizeRequest(params);
  const one = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value) ?? "";

  return (
    <main className="flex min-h-screen items-center justify-center bg-surface px-8 py-12">
      <div className="flex w-full max-w-[460px] flex-col gap-6">
        <div className="flex items-center gap-3">
          <BrandMark className="size-10" />
          <h1 className="font-serif text-[26px] font-medium tracking-[-0.01em]">Connect Claude to Dossier</h1>
        </div>
        {"error" in checked ? (
          <p role="alert" className="rounded-control bg-danger-surface px-3 py-2 text-sm text-error">
            {checked.error}
          </p>
        ) : (
          <>
            <div className="flex flex-col gap-3 text-sm leading-[1.6] text-pretty">
              <p>
                <strong>{checked.clientName}</strong> wants to use your Dossier. Once you allow it, Claude can:
              </p>
              <ul className="list-disc pl-5 text-muted">
                <li>search for jobs, keep and score postings, and run the job agent and Startups</li>
                <li>read and change your profile, without ever reading your contact details</li>
                <li>read, write and change your applications: documents, emails, notes when you ask, status and PDFs</li>
                <li>fill in an employer&apos;s form in a browser window on this computer, for you to check and send</li>
                <li>read your inbox, draft answers, and send emails with Gmail when you ask it to</li>
                <li>change themes and settings that hold no secrets, and export your data</li>
                <li>delete applications, notes, profile entries, searches and startups when you ask it to</li>
              </ul>
              <p className="text-muted">
                It never sees your API keys or your password, and it can&apos;t delete everything or import over your data. Allow it only if
                you&apos;ve just added Dossier as a connector in Claude yourself: it sends you back to{" "}
                <strong className="text-ink">{new URL(checked.redirectUri).host}</strong>. Disconnect Claude in Settings → Claude connector at
                any time.
              </p>
            </div>
            <Consent
              request={{
                client_id: checked.clientId,
                redirect_uri: checked.redirectUri,
                code_challenge: checked.codeChallenge,
                code_challenge_method: one(params.code_challenge_method),
                state: checked.state,
                resource: checked.resource,
              }}
            />
          </>
        )}
      </div>
    </main>
  );
}
