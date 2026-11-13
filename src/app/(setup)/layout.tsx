import { verifySession } from "@/lib/auth/session";

/** The setup guide's shell (E21): the guide alone, without the sidebar, so nothing else asks for attention. */
export default async function SetupLayout({ children }: LayoutProps<"/">) {
  await verifySession();
  return <div className="min-h-screen bg-surface">{children}</div>;
}
