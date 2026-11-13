"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";

import { PageHeader } from "@/components/page-header";
import { SavedIndicator } from "@/components/saved-indicator";
import { buttonClassName } from "@/components/ui/button";
import { toastResult } from "@/components/toast";
import { factTexts, paidRoles, REQUIRED_BASICS, type CustomSection, type EntryOrder, type ProfileData } from "@/lib/profile";
import { withProfileRows, type SectionLayout } from "@/lib/resume-sections";

import { saveResumeSections } from "../resume/actions";

import { AddSectionForm } from "./add-section-form";
import { BasicsSection } from "./basics-section";
import { CertificationsSection } from "./certifications-section";
import { CustomSectionEditor } from "./custom-section";
import { EducationSection } from "./education-section";
import { ExperienceSection } from "./experience-section";
import { FactsSection } from "./facts-section";
import { ProjectsSection } from "./projects-section";
import { PublicationsSection } from "./publications-section";
import { ReferencesSection } from "./references-section";
import { TrackSaveContext, useSaveTracker } from "@/components/save-tracker";
import { SearchWordsPanel } from "./search-words-panel";
import { LanguagesSection, SkillsSection, type SkillOrder } from "./skills-section";
import { StrengthMeter } from "./strength-meter";
import { SummarySection } from "./summary-section";
import { SectionNav } from "./section-nav";
import { navSections, sectionHref, type ProfilePage, type ProfileSectionId, type SectionId } from "./sections";

/**
 * The guided profile editor (PRD §6.2). It keeps the whole profile in state,
 * so section counts update as you type; each section saves its own changes.
 */
/** How experience, projects and education are ordered (E4-9), from Settings. */
export type ProfileOrder = { experience: EntryOrder; projects: EntryOrder; education: EntryOrder; skills: SkillOrder };

export function ProfileEditor({ initial, section, order, sections }: { initial: ProfileData; section: ProfilePage; order: ProfileOrder; sections: SectionLayout }) {
  const [profile, setProfile] = useState(initial);
  const [layout, setLayout] = useState(sections);
  const saves = useSaveTracker();
  const router = useRouter();

  const nav = navSections(profile.customSections, layout.order);
  const index = nav.findIndex((entry) => entry.id === section);
  // Nothing while adding a section, and for a moment after deleting the one on screen.
  const current = nav[index];
  const previous = nav[index - 1];
  const next = nav[index + 1];
  const customOf = (id: ProfileSectionId) => profile.customSections.find((entry) => `custom:${entry.id}` === id);
  const custom = section === "new" ? undefined : customOf(section);

  // Profile strength counts the summary with the basics; here it has its own row.
  const basicsAsked = REQUIRED_BASICS.filter((field) => field !== "summary");
  const counts: Record<SectionId, string> = {
    basics: `${basicsAsked.filter((field) => profile.basics[field].trim()).length}/${basicsAsked.length}`,
    summary: `${profile.basics.summary.trim() ? 1 : 0}/1`,
    skills: String(profile.skills.length),
    languages: String(profile.languages.length),
    experience: String(paidRoles(profile.experience).length),
    volunteering: String(profile.experience.length - paidRoles(profile.experience).length),
    projects: String(profile.projects.length),
    education: String(profile.education.length),
    certifications: String(profile.certifications.length),
    publications: String(profile.publications.length),
    references: String(profile.references.length),
    facts: String(factTexts(profile.facts).length),
  };

  const body: Record<SectionId, ReactNode> = {
    basics: (
      <BasicsSection
        basics={profile.basics}
        onChange={(basics) => setProfile((current) => ({ ...current, basics }))}
        photo={profile.photo}
        onPhotoChange={(photo) => setProfile((current) => ({ ...current, photo }))}
      />
    ),
    summary: <SummarySection basics={profile.basics} onChange={(basics) => setProfile((current) => ({ ...current, basics }))} />,
    skills: <SkillsSection profile={profile} update={setProfile} order={order.skills} />,
    languages: <LanguagesSection profile={profile} update={setProfile} />,
    experience: <ExperienceSection profile={profile} update={setProfile} order={order.experience} />,
    volunteering: <ExperienceSection key="volunteering" profile={profile} update={setProfile} order={order.experience} volunteering />,
    projects: <ProjectsSection profile={profile} update={setProfile} order={order.projects} />,
    education: <EducationSection profile={profile} update={setProfile} order={order.education} />,
    certifications: <CertificationsSection profile={profile} update={setProfile} />,
    publications: <PublicationsSection profile={profile} update={setProfile} />,
    references: <ReferencesSection profile={profile} update={setProfile} />,
    facts: <FactsSection profile={profile} update={setProfile} />,
  };

  const addSection = (added: CustomSection) => setProfile((state) => ({ ...state, customSections: [...state.customSections, added] }));
  const sectionDeleted = (deleted: CustomSection) => {
    setProfile((state) => ({ ...state, customSections: state.customSections.filter((entry) => entry.id !== deleted.id) }));
    router.push(sectionHref((next ?? previous).id));
  };

  const moveRows = async (rows: string[]) => {
    const before = layout;
    const next = { ...layout, order: withProfileRows(layout.order, rows) };
    setLayout(next);
    if (!toastResult(await saves.track(saveResumeSections(next))).ok) setLayout(before);
  };

  return (
    <TrackSaveContext value={saves.track}>
      <PageHeader
        title="Your profile"
        description="Everything here feeds your resumes and cover letters. Fill in what you like. You can always come back to it."
        actions={
          <>
            <SavedIndicator status={saves.status} savedAt={saves.savedAt} />
            <Link href="/profile/import" className={buttonClassName("secondary")}>
              Import from a resume
            </Link>
            <Link href="/resume" className={buttonClassName("primary", "md", "hover:text-on-primary")}>
              See base resume →
            </Link>
          </>
        }
      />

      <div className="flex flex-wrap items-start gap-x-12 gap-y-10 px-10 pt-2 pb-20">
        <div className="flex max-w-[260px] min-w-[220px] flex-[1_1_240px] flex-col gap-6">
          <StrengthMeter profile={profile} />
          <SectionNav
            rows={nav.map((entry) => ({ ...entry, count: customOf(entry.id)?.items.length.toString() ?? counts[entry.id as SectionId] }))}
            current={section}
            onMove={(rows) => void moveRows(rows)}
          />
          <p className="text-label text-pretty text-muted">
            Drag to reorder. Resumes use this order unless one has its own, and two-column themes keep some sections in the sidebar.
          </p>
        </div>

        <div className="flex max-w-[760px] min-w-0 flex-[999_1_420px] flex-col gap-6">
          {section === "new" ? (
            <>
              <div className="flex flex-col gap-1.5">
                <h2 className="font-serif text-section">Add a section</h2>
                <p className="text-sm text-pretty text-muted">Awards, talks, memberships: anything the other sections don&apos;t cover. It goes on resumes as you write it.</p>
              </div>
              <AddSectionForm
                onAdded={(added) => {
                  addSection(added);
                  router.push(sectionHref(`custom:${added.id}`));
                }}
                onCancel={() => router.back()}
              />
            </>
          ) : (
            current && (
              <>
            <div className="flex flex-col gap-1.5">
              <h2 className="font-serif text-section">{current.title}</h2>
              <p className="text-sm text-pretty text-muted">
                {current.optional && "Optional. "}
                {current.hint}
              </p>
            </div>

            {custom ? <CustomSectionEditor key={custom.id} section={custom} update={setProfile} onDeleted={sectionDeleted} onRestored={addSection} /> : body[section as SectionId]}

            <div className="flex items-center justify-between gap-3 pt-2">
              {previous ? (
                <Link href={sectionHref(previous.id)} className={buttonClassName("text")}>
                  ← {previous.label}
                </Link>
              ) : (
                <span />
              )}
              {next ? (
                <Link href={sectionHref(next.id)} className={buttonClassName("secondary", "md", "bg-card")}>
                  Next: {next.label} →
                </Link>
              ) : (
                <Link href="/resume" className={buttonClassName("primary", "md", "hover:text-on-primary")}>
                  Looks good. See my resume →
                </Link>
              )}
            </div>
              </>
            )
          )}
        </div>

        <SearchWordsPanel profile={profile} />
      </div>
    </TrackSaveContext>
  );
}
