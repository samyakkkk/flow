// /api/fs/native-pick/cancel — dismiss the pending server-side folder dialog.
// The escape hatch for a browser that isn't on the machine running Flow
// (tunnel / ssh -L access looks same-machine at the network layer, so the
// dialog can open on a screen the user can't see): the UI offers "browse from
// here instead", we kill the osascript child so the dialog doesn't linger on
// the remote screen until its timeout, and the pending pick request resolves
// as a cancel.
import { NextResponse } from "next/server";
import { requireProject } from "@/lib/projectContext";
import { cancelNativePick } from "@/lib/nativePick";

export async function POST(): Promise<NextResponse> {
  await requireProject();
  return NextResponse.json({ canceled: cancelNativePick() });
}
