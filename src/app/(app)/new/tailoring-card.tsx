"use client";

import { useId } from "react";

import { Card } from "@/components/ui/card";
import { Select } from "@/components/ui/select";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Textarea } from "@/components/ui/textarea";
import { Tone } from "@/generated/prisma/enums";
import { DOCUMENTS_TO_WRITE, type DocumentsToWrite } from "@/lib/settings";
import { TONES } from "@/lib/tones";

const TONE_OPTIONS = Object.values(Tone).map((tone) => ({ value: tone, label: TONES[tone].label }));
const WRITE_LABELS: Record<DocumentsToWrite, string> = { both: "Resume and letter", resume: "Resume", letter: "Cover letter" };
const WRITE_OPTIONS = DOCUMENTS_TO_WRITE.map((value) => ({ value, label: WRITE_LABELS[value] }));

const POSTING_LANGUAGE = "__posting";

/** "Tailoring" (E7-5, NEW-6): what to write (#367), the language of the documents, the cover letter's tone, and a note for the AI. */
export function TailoringCard({
  write,
  tone,
  note,
  language,
  languages,
  postingLanguage,
  onWrite,
  onTone,
  onNote,
  onLanguage,
}: {
  write: DocumentsToWrite;
  tone: Tone;
  note: string;
  /** The language for this application; null is the posting's. */
  language: string | null;
  languages: string[];
  /** The language the posting was read as, when it said. */
  postingLanguage: string | null;
  onWrite: (write: DocumentsToWrite) => void;
  onTone: (tone: Tone) => void;
  onNote: (note: string) => void;
  onLanguage: (language: string | null) => void;
}) {
  const writeId = useId();
  const labelId = useId();
  const descriptionId = useId();
  return (
    <Card className="flex flex-col gap-5 py-6">
      <h2 className="text-[15px] font-medium">Tailoring</h2>
      <div className="flex flex-col gap-[9px]">
        <span id={writeId} className="text-label text-muted">
          Write
        </span>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <SegmentedControl aria-labelledby={writeId} options={WRITE_OPTIONS} value={write} onValueChange={onWrite} />
          {write !== "both" && <span className="text-meta text-muted">The other can be written later, from the application.</span>}
        </div>
      </div>
      {write !== "resume" && (
      <div className="flex flex-col gap-[9px]">
        <span id={labelId} className="text-label text-muted">
          Cover letter tone
        </span>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <SegmentedControl
            aria-labelledby={labelId}
            aria-describedby={descriptionId}
            options={TONE_OPTIONS}
            value={tone}
            onValueChange={onTone}
          />
          <span id={descriptionId} className="text-meta text-muted">
            {TONES[tone].description}
          </span>
        </div>
      </div>
      )}
      <Select
        label="Write the documents in"
        hint="The resume and the cover letter are both written in it, for this application only."
        value={language ?? POSTING_LANGUAGE}
        onChange={(event) => onLanguage(event.target.value === POSTING_LANGUAGE ? null : event.target.value)}
      >
        <option value={POSTING_LANGUAGE}>{`The posting's language${postingLanguage ? ` (${postingLanguage})` : ""}`}</option>
        {languages.map((name) => (
          <option key={name} value={name}>
            {name}
          </option>
        ))}
      </Select>
      <Textarea
        label="Anything I should know?"
        hint="Kept with the application as a fact for the AI. Change it later on its Job posting tab."
        rows={3}
        placeholder="e.g. I'm relocating to Amsterdam in January. Or: lean on my research work."
        value={note}
        onChange={(event) => onNote(event.target.value)}
      />
    </Card>
  );
}
