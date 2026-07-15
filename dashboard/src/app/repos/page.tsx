import { redirect } from "next/navigation";
import { headers } from "next/headers";

// The /repos page has been merged into the home page (/).
// Sources, reindex, branch, and remove actions are all available there.
export default async function ReposPage() {
  const name = (await headers()).get("x-flow-project");
  if (name) redirect(`/${name}/`);
  redirect("/");
}
