"use client";

import { ScreenError, type ErrorPageProps } from "@/components/screen-error";

export default function RecruitersError(props: ErrorPageProps) {
  return <ScreenError {...props} title="Recruiters didn't load" />;
}
