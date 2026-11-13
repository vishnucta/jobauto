import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { loadProfile } from "@/lib/profile-data";
import { loadSettings } from "@/lib/settings-data";
import { createTestClient, resetDatabase } from "@/test/db";

import { addLanguage, addSkill, applyProfileImport, attachNewProjectSkill, attachNewSkill, createCertification, createCustomItem, createCustomSection, createEducation, createExperience, createProject, createPublication, createReference, deleteCustomSection, discardProfileImport, removeCertification, removeCustomItem, removeEducation, removeExperience, removeLanguage, removePhoto, removeProject, removePublication, removeReference, removeSkill, renameSkillGroup, reorderCertifications, reorderCustomItems, reorderEntries, reorderPublications, reorderSkills, restoreCertification, restoreCustomItem, restoreCustomSection, restoreEducation, restoreExperience, restoreProject, restorePublication, restoreReference, saveBasics, saveCertification, saveCustomItem, saveCustomSection, saveEducation, saveExperience, savePhoto, saveProject, savePublication, saveReference, setExperienceSkill, setRoleVolunteering, setLanguageLevel, setPhotoOnResumes, setProjectSkill, setSkillGroup, setSkillOrder, sortEntriesByDate } from "./actions";

// The actions run against the test database, signed in.
const db = vi.hoisted(() => ({ client: undefined as ReturnType<typeof createTestClient> | undefined }));
vi.mock("@/lib/prisma", async () => {
  const { createTestClient } = await import("@/test/db");
  db.client = createTestClient();
  return { prisma: db.client };
});
vi.mock("@/lib/auth/session", () => ({
  getSession: async () => ({ persistent: false, issuedAt: new Date(), expiresAt: new Date(Date.now() + 60_000) }),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const prisma = () => db.client!;

beforeEach(() => resetDatabase(prisma()));
afterAll(() => prisma().$disconnect());

const basics = {
  name: "Jane Doe", headline: "", email: "", phone: "", dob: "1992-04-18", website: "",
  address: "", city: "", country: "", linkedin: "", summary: "", showAge: true,
};

describe("profile actions", () => {
  it("saves the basics as one row per filled-in field, and removes cleared ones", async () => {
    const fields = () => prisma().profileField.findMany({ select: { key: true, value: true }, orderBy: { key: "asc" } });
    await expect(saveBasics(basics)).resolves.toEqual({ ok: true, data: null });
    expect(await fields()).toEqual([
      { key: "dob", value: "1992-04-18" },
      { key: "name", value: "Jane Doe" },
      { key: "showAge", value: "true" },
    ]);
    expect((await loadProfile()).basics).toEqual(basics);

    await saveBasics({ ...basics, dob: "", showAge: false });
    expect(await fields()).toEqual([{ key: "name", value: "Jane Doe" }]);
  });

  it("adds skills in order and ignores duplicates in any case", async () => {
    const figma = await addSkill({ name: " Figma " });
    expect(figma).toMatchObject({ ok: true, data: { added: true, skill: { name: "Figma" } } });
    await addSkill({ name: "User research" });
    const again = await addSkill({ name: "FIGMA" });
    expect(again).toMatchObject({ ok: true, data: { added: false, skill: { name: "Figma" } } });

    const skills = await prisma().skill.findMany({ orderBy: { sort: "asc" } });
    expect(skills.map((skill) => skill.name)).toEqual(["Figma", "User research"]);
    expect(await addSkill({ name: "   " })).toMatchObject({ ok: false, fieldErrors: { name: ["Type a skill first."] } });
  });

  it("saves an order of skills set by hand, which tailored resumes then keep (public issue 62)", async () => {
    const figma = await addSkill({ name: "Figma" });
    const research = await addSkill({ name: "User research" });
    const systems = await addSkill({ name: "Design systems" });
    if (!figma.ok || !research.ok || !systems.ok) throw new Error("not added");
    const ids = [systems.data.skill.id, figma.data.skill.id, research.data.skill.id];
    expect(await reorderSkills({ ids })).toEqual({ ok: true, data: null });
    expect((await loadProfile()).skills.map((skill) => skill.name)).toEqual(["Design systems", "Figma", "User research"]);
    expect((await loadSettings()).skillOrder).toBe("manual");
    // A skill added later goes last.
    await addSkill({ name: "Accessibility" });
    expect((await loadProfile()).skills.map((skill) => skill.name)).toEqual(["Design systems", "Figma", "User research", "Accessibility"]);
    // A list that doesn't match the skills changed in the meantime.
    expect(await reorderSkills({ ids })).toMatchObject({ ok: false, error: expect.stringMatching(/changed in the meantime/) });
    expect(await setSkillOrder({ order: "relevance" })).toEqual({ ok: true, data: null });
    expect((await loadSettings()).skillOrder).toBe("relevance");
  });

  it("puts skills in groups, moves them, and renames a group with its skills (#280)", async () => {
    const figma = await addSkill({ name: "Figma", group: "Tools" });
    expect(figma).toMatchObject({ ok: true, data: { added: true, skill: { name: "Figma", group: "Tools" } } });
    // One that's there already moves to the group it's added to.
    expect(await addSkill({ name: "figma", group: "Design" })).toMatchObject({ ok: true, data: { added: false, skill: { name: "Figma", group: "Design" } } });
    await addSkill({ name: "Prototyping", group: "Design" });
    await addSkill({ name: "User research" });

    const id = (await prisma().skill.findFirstOrThrow({ where: { name: "User research" } })).id;
    expect(await setSkillGroup({ id, group: " Research " })).toEqual({ ok: true, data: null });
    expect(await renameSkillGroup({ from: "Design", to: "Interface" })).toEqual({ ok: true, data: null });
    const groups = await prisma().skill.findMany({ orderBy: { sort: "asc" }, select: { name: true, group: true } });
    expect(groups).toEqual([
      { name: "Figma", group: "Interface" },
      { name: "Prototyping", group: "Interface" },
      { name: "User research", group: "Research" },
    ]);

    expect(await addSkill({ name: "Ahrefs", group: "Tools: SEO" })).toMatchObject({ ok: false, fieldErrors: { group: ["A group's name can't have “:” or “·” in it."] } });
    expect(await renameSkillGroup({ from: "Interface", to: " " })).toMatchObject({ ok: false, fieldErrors: { to: ["Give the group a name."] } });
  });

  it("detaches a removed skill from every role", async () => {
    const skill = await prisma().skill.create({ data: { name: "Figma" } });
    await prisma().experience.create({ data: { role: "Designer", skills: { create: { skillId: skill.id } } } });

    await expect(removeSkill({ id: skill.id })).resolves.toEqual({ ok: true, data: null });
    expect(await prisma().experienceSkill.count()).toBe(0);
    // Removing it again is harmless.
    await expect(removeSkill({ id: skill.id })).resolves.toEqual({ ok: true, data: null });
  });

  it("adds languages, and updates the level when one is added again in another case", async () => {
    const dutch = await addLanguage({ name: "Dutch", level: "NATIVE" });
    expect(dutch).toMatchObject({ ok: true, data: { added: true, language: { name: "Dutch", level: "NATIVE" } } });
    await addLanguage({ name: "German", level: "B1" });

    const again = await addLanguage({ name: "german", level: "B2" });
    expect(again).toMatchObject({ ok: true, data: { added: false, language: { name: "German", level: "B2" } } });
    expect(await prisma().language.count()).toBe(2);
  });

  it("changes a language's level and removes it", async () => {
    const { id } = await prisma().language.create({ data: { name: "English", level: "C1" } });
    await setLanguageLevel({ id, level: "C2" });
    expect((await prisma().language.findUniqueOrThrow({ where: { id } })).level).toBe("C2");
    await removeLanguage({ id });
    expect(await prisma().language.count()).toBe(0);
  });

  it("creates, saves, removes and restores a role with its skill links", async () => {
    const figma = await prisma().skill.create({ data: { name: "Figma" } });
    const research = await prisma().skill.create({ data: { name: "User research" } });
    const created = await createExperience({});
    if (!created.ok) throw new Error(created.error);
    expect(created.data).toMatchObject({ role: "", current: false, skillIds: [] });

    expect(created.data.descriptor).toBe("");
    expect(created.data.volunteering).toBe(false);
    const entry = { ...created.data, role: "Product Designer", company: "Fieldnote", descriptor: "Note-taking app, 20 people", startYear: 2018, startMonth: 6, endYear: 2021, endMonth: 2 };
    await saveExperience(entry);
    await setRoleVolunteering({ id: entry.id, volunteering: true });
    expect(await prisma().experience.findUniqueOrThrow({ where: { id: entry.id } })).toMatchObject({ volunteering: true });
    // The field isn't an autosave's to change: one on its way can't move the role back.
    await saveExperience(entry);
    expect(await prisma().experience.findUniqueOrThrow({ where: { id: entry.id } })).toMatchObject({ volunteering: true });
    await setRoleVolunteering({ id: entry.id, volunteering: false });
    await prisma().experienceSkill.createMany({ data: [{ experienceId: entry.id, skillId: figma.id }, { experienceId: entry.id, skillId: research.id }] });

    await removeExperience({ id: entry.id });
    expect(await prisma().experience.count()).toBe(0);
    // A save that arrives after the removal does nothing.
    await expect(saveExperience(entry)).resolves.toEqual({ ok: true, data: null });
    expect(await prisma().experience.count()).toBe(0);

    // Undo: the role comes back with links to the skills that still exist.
    await prisma().skill.delete({ where: { id: research.id } });
    const restored = await restoreExperience({ ...entry, skillIds: [figma.id, research.id] });
    expect(restored).toMatchObject({ ok: true, data: { id: entry.id, role: "Product Designer", skillIds: [figma.id] } });
    expect(await prisma().experience.findUniqueOrThrow({ where: { id: entry.id } })).toMatchObject({
      company: "Fieldnote",
      descriptor: "Note-taking app, 20 people",
      startYear: 2018,
      endMonth: 2,
    });
  });

  it("rejects impossible dates", async () => {
    const created = await createExperience({});
    if (!created.ok) throw new Error(created.error);
    expect(await saveExperience({ ...created.data, startMonth: 13 })).toMatchObject({ ok: false });
    expect(await saveExperience({ ...created.data, startYear: 21 })).toMatchObject({ ok: false });
  });

  it("attaches and detaches skills, and adds a new one in one step", async () => {
    const role = await prisma().experience.create({ data: { role: "Designer" } });
    const figma = await prisma().skill.create({ data: { name: "Figma" } });

    await setExperienceSkill({ experienceId: role.id, skillId: figma.id, attached: true });
    await setExperienceSkill({ experienceId: role.id, skillId: figma.id, attached: true }); // twice is fine
    expect(await prisma().experienceSkill.count()).toBe(1);

    const added = await attachNewSkill({ experienceId: role.id, name: "Accessibility" });
    expect(added).toMatchObject({ ok: true, data: { added: true, skill: { name: "Accessibility" } } });
    const again = await attachNewSkill({ experienceId: role.id, name: "FIGMA" });
    expect(again).toMatchObject({ ok: true, data: { added: false, skill: { id: figma.id } } });
    expect(await prisma().skill.count()).toBe(2);
    expect(await prisma().experienceSkill.count()).toBe(2);

    await setExperienceSkill({ experienceId: role.id, skillId: figma.id, attached: false });
    expect(await prisma().experienceSkill.count()).toBe(1);
  });

  it("creates, saves, removes and restores a project with its skill links (PRO-13)", async () => {
    const python = await prisma().skill.create({ data: { name: "Python" } });
    const pandas = await prisma().skill.create({ data: { name: "pandas" } });
    const created = await createProject({});
    if (!created.ok) throw new Error(created.error);
    expect(created.data).toMatchObject({ name: "", link: "", bullets: "", current: false, skillIds: [] });

    const entry = { ...created.data, name: "Churn predictor", link: "github.com/jane/churn", bullets: "Trained a model\nShipped a dashboard", startYear: 2025, startMonth: 2, current: true };
    expect(await saveProject(entry)).toEqual({ ok: true, data: null });
    await setProjectSkill({ projectId: entry.id, skillId: python.id, attached: true });
    await setProjectSkill({ projectId: entry.id, skillId: python.id, attached: true }); // twice is fine
    const added = await attachNewProjectSkill({ projectId: entry.id, name: "PANDAS" });
    expect(added).toMatchObject({ ok: true, data: { added: false, skill: { id: pandas.id } } });
    expect(await prisma().projectSkill.count()).toBe(2);
    expect((await loadProfile()).projects).toEqual([{ ...entry, skillIds: expect.arrayContaining([python.id, pandas.id]) }]);
    await setProjectSkill({ projectId: entry.id, skillId: pandas.id, attached: false });
    expect(await prisma().projectSkill.count()).toBe(1);

    await removeProject({ id: entry.id });
    expect(await prisma().project.count()).toBe(0);
    // A save that arrives after the removal does nothing.
    await expect(saveProject(entry)).resolves.toEqual({ ok: true, data: null });
    expect(await prisma().project.count()).toBe(0);

    // Undo: the project comes back with links to the skills that still exist.
    await prisma().skill.delete({ where: { id: pandas.id } });
    const restored = await restoreProject({ ...entry, skillIds: [python.id, pandas.id] });
    expect(restored).toMatchObject({ ok: true, data: { id: entry.id, name: "Churn predictor", skillIds: [python.id] } });
    // Removing a skill detaches it from projects too.
    await removeSkill({ id: python.id });
    expect(await prisma().projectSkill.count()).toBe(0);
  });

  it("creates, saves, removes and restores education and references", async () => {
    const school = await createEducation({});
    const person = await createReference({});
    if (!school.ok || !person.ok) throw new Error("create failed");

    const degree = { ...school.data, degree: "MSc", school: "TU Delft", startYear: 2013, endYear: 2015 };
    const reference = { ...person.data, name: "Jane Doe", email: "jane.doe@example.com" };
    await saveEducation(degree);
    await saveReference(reference);
    expect(await prisma().education.findUniqueOrThrow({ where: { id: degree.id } })).toMatchObject({ school: "TU Delft", endYear: 2015 });

    await removeEducation({ id: degree.id });
    await removeReference({ id: reference.id });
    expect(await prisma().education.count() + await prisma().reference.count()).toBe(0);

    await expect(restoreEducation(degree)).resolves.toMatchObject({ ok: true, data: { degree: "MSc" } });
    await expect(restoreReference(reference)).resolves.toMatchObject({ ok: true, data: { name: "Jane Doe" } });
    expect(await prisma().reference.findUniqueOrThrow({ where: { id: reference.id } })).toMatchObject({ email: "jane.doe@example.com" });
  });
});

describe("publications (#218)", () => {
  it("creates new ones at the top, saves, removes and restores them", async () => {
    const older = await createPublication({});
    const newer = await createPublication({});
    if (!older.ok || !newer.ok) throw new Error("create failed");
    expect(newer.data).toEqual({ id: newer.data.id, citation: "", link: "", onResumes: true });
    expect((await loadProfile()).publications.map((entry) => entry.id)).toEqual([newer.data.id, older.data.id]);

    const entry = { ...newer.data, citation: "**Doe, J.** (2024). *Calm payouts.*", link: "https://doi.org/10.5555/1", onResumes: false };
    await savePublication(entry);
    expect((await loadProfile()).publications[0]).toEqual(entry);

    await removePublication({ id: entry.id });
    expect(await prisma().publication.count()).toBe(1);
    await expect(restorePublication(entry)).resolves.toEqual({ ok: true, data: entry });
  });

  it("saves an order set by hand, and refuses a list that changed meanwhile", async () => {
    const ids = [];
    for (let index = 0; index < 3; index++) {
      const created = await createPublication({});
      if (!created.ok) throw new Error("create failed");
      ids.push(created.data.id);
    }
    expect(await reorderPublications({ ids: [ids[2], ids[0], ids[1]] })).toEqual({ ok: true, data: null });
    expect((await loadProfile()).publications.map((entry) => entry.id)).toEqual([ids[2], ids[0], ids[1]]);
    expect(await reorderPublications({ ids: [ids[0], ids[1]] })).toMatchObject({ ok: false, error: expect.stringMatching(/^The list changed/) });
  });
});

describe("custom sections (#298)", () => {
  const items = async () => (await loadProfile()).customSections[0].items;

  it("makes a section with a name, and refuses one without", async () => {
    expect(await createCustomSection({ title: "  ", format: "LINES" })).toMatchObject({ ok: false });
    const created = await createCustomSection({ title: " Awards ", format: "LINES" });
    if (!created.ok) throw new Error("not created");
    expect(await prisma().customSection.findUnique({ where: { id: created.data } })).toMatchObject({ title: "Awards", format: "LINES" });
  });

  it("deletes a section with its items, and Undo brings back both with their ids", async () => {
    const created = await createCustomSection({ title: "Awards", format: "LINES" });
    if (!created.ok) throw new Error("not created");
    await prisma().customItem.create({ data: { id: "i1", sectionId: created.data, title: "Best Paper" } });
    await deleteCustomSection({ id: created.data });
    expect(await prisma().customItem.count()).toBe(0);

    const item = { id: "i1", title: "Best Paper", subtitle: "", startYear: null, startMonth: null, endYear: null, endMonth: null, current: false, details: "", link: "", onResumes: true };
    await restoreCustomSection({ id: created.data, title: "Awards", format: "LINES", items: [item] });
    expect(await prisma().customSection.findUnique({ where: { id: created.data }, include: { items: true } })).toMatchObject({ title: "Awards", items: [{ id: "i1", title: "Best Paper" }] });
  });
  const fieldsOf = (item: Awaited<ReturnType<typeof items>>[number]) => ({ ...item, sectionId: "s1" });
  const resumeOf = async (applicationId: string) =>
    (await prisma().document.findUniqueOrThrow({ where: { applicationId_kind: { applicationId, kind: "RESUME" } } })).units as { id: string; text: string }[];

  beforeEach(async () => {
    await prisma().customSection.create({ data: { id: "s1", title: "Awards", format: "ENTRIES" } });
  });

  it("adds items at the end, saves, reorders, removes and restores them", async () => {
    const first = await createCustomItem({ sectionId: "s1", title: "First" });
    const second = await createCustomItem({ sectionId: "s1" });
    if (!first.ok || !second.ok) throw new Error("not created");
    await saveCustomItem(fieldsOf({ ...second.data, title: "Second", details: "A bullet" }));
    expect((await items()).map((item) => item.title)).toEqual(["First", "Second"]);

    await reorderCustomItems({ sectionId: "s1", ids: [second.data.id, first.data.id] });
    expect((await items()).map((item) => item.title)).toEqual(["Second", "First"]);
    expect(await reorderCustomItems({ sectionId: "s1", ids: [first.data.id] })).toMatchObject({ ok: false });

    await removeCustomItem({ id: first.data.id });
    expect(await items()).toHaveLength(1);
    await restoreCustomItem(fieldsOf(first.data));
    expect((await items()).map((item) => item.title)).toEqual(["Second", "First"]);
  });

  it("doesn't add to a section that's gone", async () => {
    expect(await createCustomItem({ sectionId: "gone" })).toMatchObject({ ok: false });
  });

  it("keeps a section's name when it's left blank", async () => {
    await saveCustomSection({ id: "s1", title: "  ", format: "LINES" });
    expect((await loadProfile()).customSections[0]).toMatchObject({ title: "Awards", format: "LINES" });
  });

  it("gives drafts that hold the section its parts in the new format, and leaves sent resumes alone", async () => {
    const item = await createCustomItem({ sectionId: "s1", title: "Best Paper" });
    if (!item.ok) throw new Error("not created");
    await saveCustomItem(fieldsOf({ ...item.data, details: "Out of 900" }));
    const units = [{ id: "summary", label: "Summary", text: "Hello" }, { id: `custom-entry:${item.data.id}`, label: "Best Paper", text: "Edited by hand" }, { id: "skills", label: "Skills", text: "Figma" }];
    const create = (id: string, sentAt: Date | null) =>
      prisma().application.create({ data: { id, status: sentAt ? "SENT" : "DRAFT", sentAt, documents: { create: { kind: "RESUME", units } } } });
    await create("draft", null);
    await create("sent", new Date());
    await prisma().application.create({ data: { id: "other", documents: { create: { kind: "RESUME", units: [{ id: "summary", label: "Summary", text: "Hi" }] } } } });

    await saveCustomSection({ id: "s1", title: "Awards", format: "LINES" });
    expect(await resumeOf("draft")).toEqual([units[0], { id: `custom-line:${item.data.id}`, label: "Best Paper", text: "Best Paper" }, units[2]]);
    expect(await resumeOf("sent")).toEqual(units);
    expect(await resumeOf("other")).toEqual([{ id: "summary", label: "Summary", text: "Hi" }]);

    await saveCustomSection({ id: "s1", title: "Awards", format: "INLINE" });
    expect((await resumeOf("draft"))[1]).toEqual({ id: "custom-inline:s1", label: "Awards", text: "Best Paper" });
  });
});

describe("certifications (#293)", () => {
  it("creates new ones at the top, saves, removes and restores them", async () => {
    const older = await createCertification({});
    const newer = await createCertification({});
    if (!older.ok || !newer.ok) throw new Error("create failed");
    expect(newer.data).toEqual({
      id: newer.data.id,
      name: "",
      issuer: "",
      year: null,
      month: null,
      expiryYear: null,
      expiryMonth: null,
      credentialId: "",
      link: "",
      onResumes: true,
    });
    expect((await loadProfile()).certifications.map((entry) => entry.id)).toEqual([newer.data.id, older.data.id]);

    const entry = {
      ...newer.data,
      name: "Certified Accessibility Specialist",
      issuer: "Inclusive Design Institute",
      year: 2022,
      month: 6,
      expiryYear: 2028,
      expiryMonth: null,
      credentialId: "IDI-20481",
      link: "verify.example.org/IDI-20481",
      onResumes: false,
    };
    await saveCertification(entry);
    expect((await loadProfile()).certifications[0]).toEqual(entry);

    await removeCertification({ id: entry.id });
    expect(await prisma().certification.count()).toBe(1);
    await expect(restoreCertification(entry)).resolves.toEqual({ ok: true, data: entry });
  });

  it("refuses a month that isn't one", async () => {
    const created = await createCertification({});
    if (!created.ok) throw new Error("create failed");
    expect(await saveCertification({ ...created.data, month: 13 })).toMatchObject({ ok: false });
  });

  it("saves an order set by hand, and refuses a list that changed meanwhile", async () => {
    const ids = [];
    for (let index = 0; index < 3; index++) {
      const created = await createCertification({});
      if (!created.ok) throw new Error("create failed");
      ids.push(created.data.id);
    }
    expect(await reorderCertifications({ ids: [ids[2], ids[0], ids[1]] })).toEqual({ ok: true, data: null });
    expect((await loadProfile()).certifications.map((entry) => entry.id)).toEqual([ids[2], ids[0], ids[1]]);
    expect(await reorderCertifications({ ids: [ids[0], ids[1]] })).toMatchObject({ ok: false, error: expect.stringMatching(/^The list changed/) });
  });
});

describe("the photo (#224)", () => {
  const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

  it("saves it, keeps it off resumes and on again, removes it and puts it back", async () => {
    expect(await savePhoto({ src: png, onResumes: true })).toEqual({ ok: true, data: null });
    expect((await loadProfile()).photo).toEqual({ src: png, onResumes: true });

    await setPhotoOnResumes({ onResumes: false });
    expect((await loadProfile()).photo).toEqual({ src: png, onResumes: false });
    await setPhotoOnResumes({ onResumes: true });
    expect(await prisma().profileField.findMany({ select: { key: true } })).toEqual([{ key: "photo" }]);

    await removePhoto({});
    expect((await loadProfile()).photo).toBeNull();
    await savePhoto({ src: png, onResumes: false });
    expect((await loadProfile()).photo).toEqual({ src: png, onResumes: false });
  });

  it("refuses anything but a JPEG, PNG or WebP image", async () => {
    const svg = `data:image/svg+xml;base64,${btoa("<svg xmlns='http://www.w3.org/2000/svg'/>")}`;
    expect(await savePhoto({ src: svg, onResumes: true })).toMatchObject({ ok: false });
    expect(await savePhoto({ src: "https://example.com/me.jpg", onResumes: true })).toMatchObject({ ok: false });
    expect(await prisma().profileField.count()).toBe(0);
  });

  it("stays when the basics are saved", async () => {
    await savePhoto({ src: png, onResumes: true });
    const basics = (await loadProfile()).basics;
    await saveBasics({ ...basics, name: "Jane Doe" });
    expect((await loadProfile()).photo).toEqual({ src: png, onResumes: true });
  });
});

describe("ordering experience and education (E4-9)", () => {
  async function role(roleName: string, startYear: number | null) {
    const created = await createExperience({});
    if (!created.ok) throw new Error(created.error);
    await saveExperience({ ...created.data, role: roleName, startYear, startMonth: null, endYear: null, endMonth: null, current: false });
    return created.data.id;
  }
  const roles = async () => (await loadProfile()).experience.map((entry) => entry.role);

  it("keeps date order until an entry is moved, then the order set by hand", async () => {
    const older = await role("Older", 2015);
    const newer = await role("Newer", 2021);
    const undated = await role("Undated", null);
    expect(await roles()).toEqual(["Newer", "Older", "Undated"]);

    expect(await reorderEntries({ section: "experience", ids: [older, undated, newer] })).toEqual({ ok: true, data: null });
    expect(await roles()).toEqual(["Older", "Undated", "Newer"]);
    expect((await prisma().setting.findUnique({ where: { key: "experienceOrder" } }))?.value).toBe("manual");
    // Education keeps its own order.
    expect(await prisma().setting.findUnique({ where: { key: "educationOrder" } })).toBeNull();
  });

  it("puts a new entry first in an order set by hand, last by date", async () => {
    const first = await role("First", 2020);
    await role("Second", 2010);
    await role("Blank by date", null);
    expect((await roles()).at(-1)).toBe("Blank by date");

    const ids = (await loadProfile()).experience.map((entry) => entry.id);
    await reorderEntries({ section: "experience", ids: ids.toReversed() });
    await role("Blank by hand", null);
    expect((await roles())[0]).toBe("Blank by hand");
    expect(ids).toContain(first);
  });

  it("goes back to date order and answers with the ids in it", async () => {
    const older = await role("Older", 2015);
    const newer = await role("Newer", 2021);
    await reorderEntries({ section: "experience", ids: [older, newer] });
    expect(await sortEntriesByDate({ section: "experience" })).toEqual({ ok: true, data: [newer, older] });
    expect(await roles()).toEqual(["Newer", "Older"]);
  });

  it("orders projects the same way, with their own setting (PRO-13)", async () => {
    const a = await createProject({});
    const b = await createProject({});
    if (!a.ok || !b.ok) throw new Error("not created");
    await saveProject({ ...a.data, name: "Older", startYear: 2019 });
    await saveProject({ ...b.data, name: "Newer", startYear: 2024 });
    expect((await loadProfile()).projects.map((entry) => entry.name)).toEqual(["Newer", "Older"]);
    await reorderEntries({ section: "project", ids: [a.data.id, b.data.id] });
    expect((await loadProfile()).projects.map((entry) => entry.name)).toEqual(["Older", "Newer"]);
    expect((await prisma().setting.findUnique({ where: { key: "projectOrder" } }))?.value).toBe("manual");
    expect(await prisma().setting.findUnique({ where: { key: "experienceOrder" } })).toBeNull();
    expect(await sortEntriesByDate({ section: "project" })).toEqual({ ok: true, data: [b.data.id, a.data.id] });
  });

  it("orders education the same way", async () => {
    const a = await createEducation({});
    const b = await createEducation({});
    if (!a.ok || !b.ok) throw new Error("not created");
    await reorderEntries({ section: "education", ids: [b.data.id, a.data.id] });
    expect((await loadProfile()).education.map((entry) => entry.id)).toEqual([b.data.id, a.data.id]);
  });

  it("refuses an order that doesn't match the entries", async () => {
    const one = await role("One", 2020);
    await role("Two", 2019);
    const result = await reorderEntries({ section: "experience", ids: [one] });
    expect(result).toEqual({ ok: false, error: "The list changed in the meantime. Reload the page and try again." });
    expect(await prisma().setting.findUnique({ where: { key: "experienceOrder" } })).toBeNull();
    expect(await reorderEntries({ section: "experience", ids: [one, one] })).toMatchObject({ ok: false });
  });
});

describe("applying a profile read from a resume (E4-10)", () => {
  const result = {
    profile: {
      basics: { name: "John Doe" },
      skills: [{ name: "Figma", found: true }],
      languages: [],
      experience: [],
      education: [],
      references: [],
    },
    readWith: "extract-profile@1",
  };

  it("applies a finished reading, taken from its job", async () => {
    const job = await prisma().job.create({ data: { type: "import-profile", input: { resume: "…" }, status: "DONE", result } });
    expect(await applyProfileImport({ jobId: job.id, mode: "merge" })).toEqual({
      ok: true,
      data: null,
      toast: "Added to your profile: 0 roles, 0 projects, 0 degrees, 1 skill, 0 languages, 0 references.",
    });
    expect((await loadProfile()).basics.name).toBe("John Doe");
    // The reading goes once it's used, with the resume's text.
    expect(await prisma().job.count()).toBe(0);
  });

  it("deletes a reading set aside with Choose another file, and only that one", async () => {
    const job = await prisma().job.create({ data: { type: "import-profile", input: { resume: "…" }, status: "DONE", result } });
    const other = await prisma().job.create({ data: { type: "read-posting", input: {}, status: "DONE", result } });
    expect(await discardProfileImport({ jobId: job.id })).toEqual({ ok: true, data: null });
    expect(await discardProfileImport({ jobId: other.id })).toEqual({ ok: true, data: null });
    expect(await prisma().job.findMany({ select: { id: true } })).toEqual([{ id: other.id }]);
  });

  it("refuses a reading that isn't done, or another kind of job", async () => {
    const running = await prisma().job.create({ data: { type: "import-profile", input: { resume: "…" }, status: "RUNNING" } });
    const other = await prisma().job.create({ data: { type: "read-posting", input: {}, status: "DONE", result } });
    for (const job of [running, other]) {
      expect(await applyProfileImport({ jobId: job.id, mode: "replace" })).toEqual({
        ok: false,
        error: "That resume isn't read yet, or it's no longer there. Choose the file again.",
      });
    }
  });
});

