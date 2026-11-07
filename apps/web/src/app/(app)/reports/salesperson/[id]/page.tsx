"use client";

import { use } from "react";
import { PersonDetail } from "@/features/people/PersonDetail";

/** One person's page — the same one the split pane shows beside a list (features/people/PersonDetail). */
export default function PersonPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <PersonDetail id={decodeURIComponent(id)} />;
}
