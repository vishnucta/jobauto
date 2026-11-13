"use client";

import { useRef, useState, type ChangeEvent } from "react";

import { toast, toastResult } from "@/components/toast";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Toggle } from "@/components/ui/toggle";
import { fileSize, type AttachmentView } from "@/lib/attachment-types";

import { removeAttachment, saveAttachment } from "./actions";

/**
 * Anlagen (jobauto fork), in Settings → Documents: certificates and
 * reference letters kept once, as PDFs, and sent with every application:
 * attached to the application email, named in the letter's Anlagen line,
 * and after the letter and resume in the one-PDF Bewerbungsmappe.
 */
export function AnlagenCard({ initial }: { initial: AttachmentView[] }) {
  const [attachments, setAttachments] = useState(initial);
  const [uploading, setUploading] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const upload = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = [...(event.target.files ?? [])];
    event.target.value = "";
    if (files.length === 0) return;
    setUploading(true);
    for (const file of files) {
      const response = await fetch(`/api/attachments?name=${encodeURIComponent(file.name)}`, { method: "POST", headers: { "content-type": "application/pdf" }, body: file });
      const answer = (await response.json().catch(() => ({}))) as AttachmentView & { error?: string };
      if (!response.ok) {
        toast(`${file.name}: ${answer.error ?? "It couldn't be added. Try again."}`);
        continue;
      }
      setAttachments((list) => [...list, answer]);
    }
    setUploading(false);
  };

  const replace = (saved: AttachmentView) => setAttachments((list) => list.map((entry) => (entry.id === saved.id ? saved : entry)));

  const save = async (id: string, change: { name?: string; enabled?: boolean }) => {
    const result = toastResult(await saveAttachment({ id, ...change }));
    if (result.ok) replace(result.data);
  };

  const remove = async (attachment: AttachmentView) => {
    const result = toastResult(await removeAttachment({ id: attachment.id }));
    if (result.ok) setAttachments((list) => list.filter((entry) => entry.id !== attachment.id));
  };

  const sent = attachments.filter((attachment) => attachment.enabled);

  return (
    <Card className="flex flex-col gap-4 text-sm text-pretty">
      <div className="flex flex-col gap-1">
        <h3 className="font-medium">Anlagen</h3>
        <p className="text-muted">
          Certificates and reference letters (Zeugnisse, Zertifikate, your language certificate) that German employers expect with an application. Add each once as a PDF: the ones that
          are on go with the application email, are named in the letter&apos;s Anlagen line, and come after your letter and resume in the Bewerbungsmappe, the one PDF many job portals
          ask for. Up to 8 MB each.
        </p>
      </div>
      {attachments.length > 0 && (
        <ul aria-label="Anlagen" className="flex flex-col">
          {attachments.map((attachment) => (
            <li key={attachment.id} className="flex flex-wrap items-end gap-3 border-t border-line py-3 first:border-t-0">
              <Input
                label="Named as"
                className="min-w-0 flex-[1_1_240px]"
                defaultValue={attachment.name}
                hint={`${attachment.fileName} · ${fileSize(attachment.size)}`}
                onBlur={(event) => {
                  const name = event.target.value.trim();
                  if (name && name !== attachment.name) void save(attachment.id, { name });
                }}
              />
              <a href={`/api/attachments/${attachment.id}`} target="_blank" rel="noopener noreferrer" className="pb-2 text-meta underline underline-offset-2">
                Open<span className="sr-only"> {attachment.name} (opens in a new tab)</span>
              </a>
              <Toggle
                className="pb-1.5"
                label={<span className="text-meta">Send it</span>}
                checked={attachment.enabled}
                onCheckedChange={(enabled) => void save(attachment.id, { enabled })}
              />
              <Button variant="text" size="sm" onClick={() => void remove(attachment)}>
                Remove<span className="sr-only"> {attachment.name}</span>
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <input ref={input} type="file" accept="application/pdf,.pdf" multiple hidden onChange={(event) => void upload(event)} aria-label="Add PDFs" />
        <Button variant="secondary" aria-disabled={uploading || undefined} onClick={uploading ? undefined : () => input.current?.click()}>
          {uploading ? "Adding…" : "Add PDFs"}
        </Button>
        <span className="text-meta text-muted">{attachments.length === 0 ? "None yet." : `${sent.length} of ${attachments.length} sent with applications.`}</span>
      </div>
    </Card>
  );
}
