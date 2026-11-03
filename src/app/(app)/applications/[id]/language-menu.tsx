"use client";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/**
 * "German ▾" above the Resume and Cover letter tabs' preview: the language the
 * application's documents are written in. Picking one asks to write the
 * resume, the cover letter and the email again in it ("Rewrite in…"); the
 * language they are set to can be picked too, for text that isn't in it. The
 * choice is made by the caller, once it has been confirmed. While a
 * rewrite runs, the menu says so instead.
 */
export function LanguageMenu({
  languages,
  current,
  busy,
  onChoose,
}: {
  /** The languages documents can be written in. */
  languages: string[];
  /** The application's language; "" when it isn't known. */
  current: string;
  /** The language being written now, if a rewrite is running. */
  busy: string | null;
  onChoose: (language: string) => void;
}) {
  if (busy) {
    return (
      <span role="status" className="text-control text-muted">
        Rewriting in {busy}…
      </span>
    );
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="text" size="sm" aria-label={`Language: ${current || "not set"}`} className="data-[state=open]:text-ink">
          {current || "Language"}
          <span aria-hidden="true" className="text-[10px]">
            ▼
          </span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-(--radix-dropdown-menu-content-available-height) overflow-y-auto">
        <DropdownMenuLabel>Rewrite the resume, cover letter and email in</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={current} onValueChange={onChoose}>
          {languages.map((language) => (
            <DropdownMenuRadioItem key={language} value={language}>
              {language}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
