"use client";

import { ScreenError, type ErrorPageProps } from "@/components/screen-error";

export default function CareersError(props: ErrorPageProps) {
  return <ScreenError {...props} title="Careers pages didn't load" />;
}
