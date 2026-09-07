"use client";

import { use, useCallback, useEffect, useRef, useState } from "react";
import { useProject } from "@/lib/useProject";
import type { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";

type SetupState = { repo: string; environment: string; reason: string; state: string; output: string; cursor: number; active: boolean; reset?: boolean };
export default function SetupPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { prefix } = useProject();
  const url = prefix(`/api/cloud/setup/${id}`);
  const host = useRef<HTMLDivElement>(null);
  const term = useRef<Terminal | null>(null);
  const cursor = useRef(0);
  const [setup, setSetup] = useState<SetupState | null>(null);
  const [error, setError] = useState("");
  const [opening, setOpening] = useState(false);
  const [queueing, setQueueing] = useState(false);
  const [busy, setBusy] = useState(false);
  const inputChain = useRef(Promise.resolve());
  const post = useCallback(async (body: object) => {
    const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? "Setup terminal unavailable");
    return result;
  }, [url]);

  useEffect(() => {
    let stopped = false;
    let terminal: Terminal | undefined;
    let observer: ResizeObserver | undefined;
    void (async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit")]);
      if (stopped || !host.current) return;
      terminal = new Terminal({ cursorBlink: true, fontSize: 14, scrollback: 1500, theme: { background: "#181b19" } });
      const fit = new FitAddon(); terminal.loadAddon(fit); terminal.open(host.current); fit.fit();
      term.current = terminal;
      terminal.onData(data => {
        inputChain.current = inputChain.current.then(() => post({ action: "input", data })).then(() => {}).catch(e => setError(e.message));
      });
      observer = new ResizeObserver(() => {
        fit.fit();
        void post({ action: "input", data: "", cols: terminal!.cols, rows: terminal!.rows }).catch(() => {});
      });
      observer.observe(host.current);
    })().catch(e => setError(e.message));
    return () => { stopped = true; observer?.disconnect(); terminal?.dispose(); term.current = null; cursor.current = 0; };
  }, [post]);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        if (opening) {
          const result = await post({ action: "open" });
          if (stopped) return;
          setQueueing(result.queued);
          if (!result.queued) { setOpening(false); term.current?.focus(); }
        }
        const response = await fetch(`${url}?cursor=${cursor.current}`, { cache: "no-store" });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error ?? "Unable to read setup terminal");
        if (stopped) return;
        if (term.current) { if (result.reset) term.current.reset(); term.current.write(result.output); cursor.current = result.cursor; }
        setSetup(result);
      } catch (e) { if (!stopped) { setError((e as Error).message); setOpening(false); } }
      finally { if (!stopped) timer = setTimeout(poll, 500); }
    }
    void poll();
    return () => { stopped = true; clearTimeout(timer); };
  }, [url, post, opening]);

  async function finish(complete: boolean) {
    setBusy(true); setError("");
    try { await inputChain.current; await post({ action: complete ? "complete" : "close" }); setOpening(false); setQueueing(false); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  const waiting = setup?.state === "waiting";
  return <main className="mx-auto max-w-5xl space-y-5 px-6 py-10">
    <div><p className="text-sm text-text-muted">Flow needs your help</p><h1 className="mt-2 font-display text-3xl">Set up {setup?.repo ?? "the environment"}</h1></div>
    {setup && <p>{setup.reason} <span className="text-text-muted">Environment: {setup.environment}.</span></p>}
    <p className="text-sm text-text-muted">This terminal runs on the Flow server as the same user as your agents. Install a CLI or complete its login here, then resume your task. Saved CLI logins persist; shell-only exports do not. Terminal input and output are not saved to the agent conversation.</p>
    <div className="flex flex-wrap items-center gap-3">
      <button className="rounded border border-line bg-paper px-4 py-2 disabled:opacity-50" disabled={!waiting || setup?.active || opening || busy} onClick={() => { setError(""); setOpening(true); }}>Open terminal</button>
      <button className="rounded border border-line px-4 py-2 disabled:opacity-50" disabled={!waiting || busy} onClick={() => void finish(true)}>Done — resume task</button>
      <button className="rounded px-3 py-2 text-sm disabled:opacity-50" disabled={(!setup?.active && !opening) || busy} onClick={() => void finish(false)}>Close terminal</button>
      {queueing && <span className="text-sm text-text-muted">Waiting for the machine. Another coding task is running.</span>}
      {setup && !waiting && <span className="text-sm">{setup.state === "cancelled" ? "Setup cancelled." : "Setup received. Flow will continue in the original Slack thread."}</span>}
    </div>
    <div ref={host} className="h-[480px] overflow-hidden rounded-xl bg-[#181b19] p-3" aria-label="Interactive setup terminal" />
    {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
  </main>;
}
