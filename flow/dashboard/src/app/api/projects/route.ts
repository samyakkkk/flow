import { NextResponse } from "next/server";
import { IS_LOCAL } from "@/lib/config";
import { listRegistryProjects } from "@/lib/registry";
import { currentUser } from "@/lib/auth";
import { userProjectFilter, loadAuthStore } from "@/lib/authStore";

// GET /api/projects — deployment-level: the projects this session may see,
// for the project switcher. Local mode: everything. Prod: the user's grants
// (owners see all).
export async function GET() {
  let filter: string[] | null = null;
  if (!IS_LOCAL) {
    const user = await currentUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    filter = userProjectFilter(user, loadAuthStore());
  }
  const projects = listRegistryProjects()
    .filter((p) => filter === null || filter.includes(p.name))
    .map((p) => ({ name: p.name, mode: p.mode, graph: p.graph }));
  return NextResponse.json({ projects });
}
