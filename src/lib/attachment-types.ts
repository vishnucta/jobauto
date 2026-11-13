// An Anlage as the screen shows it (attachments.ts keeps them).

export type AttachmentView = {
  id: string;
  /** What the letter's Anlagen line calls it. */
  name: string;
  fileName: string;
  /** In bytes. */
  size: number;
  /** Sent with every application. */
  enabled: boolean;
};

/** "1.2 MB", "340 KB". */
export function fileSize(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
