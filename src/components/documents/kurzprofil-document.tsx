import { ThemeLayout, type PaperSize } from "@/generated/prisma/enums";
import type { Kurzprofil } from "@/lib/kurzprofil";
import { resolveTheme, type ThemeData } from "@/lib/themes";

import { DocumentPage } from "./document-page";
import styles from "./kurzprofil.module.css";

/**
 * The Kurzprofil (jobauto fork): one page in German for recruitment
 * agencies, in the base resume's fonts and accent. Key facts first, then
 * the roles and education one line each.
 */
export function KurzprofilDocument({ profile, theme, paper }: { profile: Kurzprofil; theme: ThemeData; paper: PaperSize }) {
  return (
    <DocumentPage theme={resolveTheme(theme, ThemeLayout.SINGLE)} paper={paper} lang="de" dir="ltr" label="Kurzprofil" className={styles.page}>
      <header className={styles.header}>
        <p className={styles.kicker}>Kurzprofil</p>
        <h1 className={styles.name}>{profile.name || "Ihr Name"}</h1>
        {profile.headline && <p className={styles.headline}>{profile.headline}</p>}
        {profile.contact.length > 0 && <p className={styles.contact}>{profile.contact.join(" · ")}</p>}
      </header>

      <dl className={styles.facts}>
        {profile.facts.map(([label, value]) => (
          <div key={label} className={styles.fact}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>

      {profile.roles.length > 0 && (
        <section className={styles.section}>
          <h2>Berufliche Stationen</h2>
          <ul>
            {profile.roles.map((role, index) => (
              <li key={index} className={styles.line}>
                <span className={styles.dates}>{role.dates}</span>
                <span>
                  <strong>{role.title}</strong>
                  {role.company && <> · {role.company}</>}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {profile.education.length > 0 && (
        <section className={styles.section}>
          <h2>Ausbildung</h2>
          <ul>
            {profile.education.map((entry, index) => (
              <li key={index} className={styles.line}>
                <span className={styles.dates}>{entry.dates}</span>
                <span>
                  <strong>{entry.degree}</strong>
                  {entry.school && <> · {entry.school}</>}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </DocumentPage>
  );
}
