"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useProject } from "@/lib/useProject";

// The Inbox became the Knowledge Base — memories with attribution, corpus
// knowledge from Slack/Linear/meetings, and the correction flags that used to
// live here. Old links land there.
export default function InboxRedirect() {
  const router = useRouter();
  const { prefix } = useProject();
  useEffect(() => {
    router.replace(prefix("/knowledge"));
  }, [router, prefix]);
  return null;
}
