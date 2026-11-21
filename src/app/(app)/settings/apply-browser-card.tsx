"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { toast } from "@/components/toast";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

import { saveApplyBrowser, testApplyBrowser } from "./apply-browser-actions";

/** Where it's linked from: the Apply tab's "Change where it opens". */
export const APPLY_BROWSER_HREF = "/settings?section=answers#apply-browser";

/**
 * The apply assistant's browser window (jobauto fork), under Settings →
 * Standard answers: on the computer the app runs on, or, when that's a
 * server with no screen such as a NAS, in the Chrome on her laptop. Moved
 * here from every application's Apply tab (audit round 2), which now says
 * only where it opens.
 */
export function ApplyBrowserCard({ address: saved }: { address: string | null }) {
  const router = useRouter();
  const [address, setAddress] = useState(saved ?? "");
  const [saving, startSaving] = useTransition();
  const [testing, startTesting] = useTransition();
  const dirty = address.trim() !== (saved ?? "");

  const save = () =>
    startSaving(async () => {
      const result = await saveApplyBrowser({ address: address.trim() });
      if (!result.ok) return toast(result.error);
      if (result.toast) toast(result.toast);
      router.refresh();
    });

  const test = () =>
    startTesting(async () => {
      const result = await testApplyBrowser({ address: address.trim() });
      toast(result.ok ? `${result.data.version} answered. It's ready.` : result.error);
    });

  return (
    <section id="apply-browser" aria-labelledby="apply-browser-heading" className="flex scroll-mt-6 flex-col gap-3">
      <h3 id="apply-browser-heading" className="text-field font-medium">
        The apply assistant&apos;s browser window
      </h3>
      <Card className="flex flex-col gap-4 text-sm text-pretty">
        <p className="text-muted">
          {saved
            ? `The window opens in the Chrome on your laptop, at ${saved}. Start Chrome with the Apply shortcut before you click Open and fill it in.`
            : "The window opens on the computer the app runs on. If the app runs on a server, such as a NAS, there's no screen there: enter the address of your laptop's Chrome here."}{" "}
          How to set up the laptop is in the install guide, under Apply from a laptop.
        </p>
        <Input
          label="Your laptop's Chrome"
          hint="The laptop's Tailscale IP address and the port, e.g. http://100.101.102.103:9222. Leave it empty for a window on the computer the app runs on."
          placeholder="http://100.101.102.103:9222"
          value={address}
          onChange={(event) => setAddress(event.target.value)}
        />
        {saved && <p className="text-meta text-muted">While your laptop&apos;s Chrome is connected, the server controls it: use that window only for applying, not for your own browsing.</p>}
        <div className="flex flex-wrap items-center gap-3">
          <Button variant={dirty ? "primary" : "secondary"} aria-disabled={saving || !dirty || undefined} onClick={() => !saving && dirty && save()}>
            {saving ? "Saving…" : "Save"}
          </Button>
          <Button variant="text" aria-disabled={testing || !address.trim() || undefined} onClick={() => !testing && address.trim() && test()}>
            {testing ? "Testing…" : "Test"}
          </Button>
          {dirty && <span className="text-meta text-muted">Not saved yet</span>}
        </div>
      </Card>
    </section>
  );
}
