import "server-only";

import { profileForPrompt } from "@/lib/ai/tasks/prompt-parts";
import { loadProfile } from "@/lib/profile-data";

import { text, type ToolContext } from "../kit";

// The profile: reading it, and editing it (jobauto fork).

/** Registers these tools on the connector's server. */
export function registerProfileTools({ server, linkTo }: ToolContext): void {
  server.registerTool(
    "get_profile",
    {
      title: "Read the profile",
      description:
        "The user's profile in Dossier: headline, summary, facts about them, skills, languages, experience, projects, education and publications, with the ids save_application uses. Contact details and links are left out.",
      annotations: { readOnlyHint: true },
    },
    async () => text({ ...JSON.parse(profileForPrompt(await loadProfile())), link: linkTo("/profile") }),
  );
}
