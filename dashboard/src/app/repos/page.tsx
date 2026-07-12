import { redirect } from "next/navigation";

// The /repos page has been merged into the home page (/).
// Sources, reindex, branch, and remove actions are all available there.
export default function ReposPage() {
  redirect("/");
}
