import { useState } from "react";

/** Shared by the local environment and Cloud dashboard; enrollment stays with the host. */
export function BrainAgentSetup({ instructions, downloadUrl }: {
  instructions: string;
  downloadUrl: string;
}) {
  const [tab, setTab] = useState<"prompt" | "instructions">("prompt");
  const [message, setMessage] = useState("");
  const download = () => {
    const blob = new Blob([`---\nname: setup-flow\ndescription: Set up Flow Brain for the user's selected local coding agents.\n---\n\n${instructions}\n`], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "SKILL.md";
    link.click();
    URL.revokeObjectURL(url);
  };
  return <div className="flow-agent-setup">
    <section>
      <h3>The Mac app is optional</h3>
      <p>You can use Flow chat and manage your agents here in the browser. Install the Mac app if you prefer a desktop interface.</p>
      <a href={downloadUrl} target="_blank" rel="noreferrer">Download Flow for Mac ↗</a>
    </section>
    <section>
      <h3>Set up Flow for your local coding agents</h3>
      <p>Give these instructions to any coding agent. It will help you choose folders and configure the tools you use.</p>
      <div role="tablist" aria-label="Setup instructions">
        <button type="button" role="tab" aria-selected={tab === "prompt"} onClick={() => setTab("prompt")}>Agent prompt</button>
        <button type="button" role="tab" aria-selected={tab === "instructions"} onClick={() => setTab("instructions")}>Read instructions</button>
      </div>
      <div role="tabpanel">
        {tab === "prompt" ? <>
          <button type="button" onClick={() => { void navigator.clipboard.writeText(instructions).then(() => setMessage("Prompt copied."), () => setMessage("Copy failed. Select and copy the instructions below.")); }}>Copy setup prompt</button>
          <button type="button" onClick={download}>Download skill</button>
        </> : <p>Run the setup command once per chosen folder. The instructions include verification, repair, removal, and the trust steps your coding agent may require.</p>}
        <textarea aria-label="Flow setup instructions" readOnly value={instructions} rows={14} />
        <p role="status">{message}</p>
      </div>
    </section>
  </div>;
}
