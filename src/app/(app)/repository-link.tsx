"use client";

import { ArrowUpRight, GitFork, Star } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "@/lib/cn";
import { FORK_REPOSITORY_URL, REPOSITORY_URL } from "@/lib/releases";

import { useSidebarCollapsed } from "./sidebar-frame";

/** A link to a GitHub page in a new tab: its icon and label, and the label as a tooltip while the sidebar is collapsed. */
function SidebarLink({ href, label, icon }: { href: string; label: string; icon: ReactNode }) {
  const collapsed = useSidebarCollapsed();
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      title={collapsed ? label : undefined}
      className={cn(
        "flex w-full items-center gap-1.5 rounded-control px-3 py-1.5 text-sm font-medium text-muted hover:bg-hover hover:text-ink motion-safe:transition-colors",
        collapsed && "justify-center px-1.5",
      )}
    >
      {icon}
      <span className={cn(collapsed && "sr-only")}>{label}</span>{" "}
      <span className="sr-only">(opens in a new tab)</span>
      {!collapsed && <ArrowUpRight size={14} aria-hidden="true" className="ml-auto shrink-0" />}
    </a>
  );
}

/** The sidebar's link to Dossier's repository, for credits and support. */
export function RepositoryLink() {
  return <SidebarLink href={REPOSITORY_URL} label="Star on GitHub" icon={<Star size={16} aria-hidden="true" className="shrink-0" />} />;
}

/** The sidebar's link to this fork's source, jobauto. */
export function ForkLink() {
  return <SidebarLink href={FORK_REPOSITORY_URL} label="jobauto on GitHub" icon={<GitFork size={16} aria-hidden="true" className="shrink-0" />} />;
}
