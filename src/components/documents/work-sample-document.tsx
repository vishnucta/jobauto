import { ThemeLayout, type PaperSize } from "@/generated/prisma/enums";
import { documentLanguage } from "@/lib/document-language";
import { resolveTheme, type ThemeData } from "@/lib/themes";
import type { WorkSample } from "@/lib/work-sample";

import { DocumentPage } from "./document-page";
import styles from "./kurzprofil.module.css";

/**
 * The work sample (jobauto fork): "My first 90 days" on one page, in the
 * letter's fonts and accent, with her name at the top.
 */
export function WorkSampleDocument({ sample, name, theme, paper, language }: { sample: WorkSample; name: string; theme: ThemeData; paper: PaperSize; language: string }) {
  const { lang, dir } = documentLanguage(language, [sample.situation, ...sample.proof].join(" "));
  return (
    <DocumentPage theme={resolveTheme(theme, ThemeLayout.SINGLE)} paper={paper} lang={lang} dir={dir} label="Work sample" className={styles.page}>
      <header className={styles.header}>
        {name && <p className={styles.kicker}>{name}</p>}
        <h1 className={styles.name}>{sample.title}</h1>
        <p className={styles.headline}>{sample.situation}</p>
      </header>
      {sample.phases.map((phase) => (
        <section key={phase.heading} className={styles.section}>
          <h2>{phase.heading}</h2>
          <ul className={styles.steps}>
            {phase.steps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ul>
        </section>
      ))}
      {sample.proof.length > 0 && (
        <section className={styles.section}>
          <h2>{/^de\b/i.test(lang ?? "") ? "Wo ich das schon gemacht habe" : "Where I've done this before"}</h2>
          <ul className={styles.steps}>
            {sample.proof.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </section>
      )}
      {sample.closing && <p className={styles.closing}>{sample.closing}</p>}
    </DocumentPage>
  );
}
