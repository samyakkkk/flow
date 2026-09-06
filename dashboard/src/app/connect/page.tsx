"use client";
import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
function Connect() {
  const ticket = useSearchParams().get("ticket") ?? "";
  const [info, setInfo] = useState<{ project: string; machine: string; workspace: string; code: string; user: string } | null>(null);
  const [message, setMessage] = useState("");
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    fetch("/api/auth/device", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "inspect", ticket }) })
      .then(r => r.json()).then(d => d.error ? setMessage(d.error) : setInfo(d)).catch(() => setMessage("Could not load setup request."));
  }, [ticket]);
  async function answer(action: string) {
    setBusy(true);
    try {
      const r = await fetch("/api/auth/device", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, ticket }) });
      const d = await r.json();
      if (!r.ok) { setMessage(d.error); return; }
      setDone(true); setMessage(action === "approve" ? "Approved. Return to your terminal to finish setup." : "Connection denied. No integration was installed.");
    } catch { setMessage("Connection failed. Try again."); } finally { setBusy(false); }
  }
  return <main className="max-w-xl mx-auto p-8 space-y-5">
    <h1 className="text-3xl">Connect your tools to Flow</h1>
    {info && <><p>Connect <strong>{info.workspace}</strong> on <strong>{info.machine}</strong> to <strong>{info.project}</strong> as {info.user}.</p>
      <p>Check that your terminal shows this code: <strong className="font-mono">{info.code}</strong></p>
      <p>Approve only a setup you started on your own computer. Flow will access project knowledge and capture coding sessions from the workspace you confirm locally. This does not enable remote commands or filesystem browsing.</p>
      {!done && <div className="flex gap-3"><button disabled={busy} className="bg-ink text-paper rounded-lg px-4 py-2" onClick={() => void answer("approve")}>Approve connection</button><button disabled={busy} className="border rounded-lg px-4 py-2" onClick={() => void answer("deny")}>Deny</button></div>}</>}
    <p role="status">{message}</p>
  </main>;
}
export default function Page() { return <Suspense fallback={<p>Loading setup…</p>}><Connect /></Suspense>; }
