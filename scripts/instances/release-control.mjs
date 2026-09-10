import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { newerTag } from "../flow-release.mjs";

const disabled = { supported: false, currentVersion: null, readyVersion: null, restarting: false };

async function receipt(path) {
  return JSON.parse(await NodeFSP.readFile(path, "utf8"));
}

// The supervisor owns this state so a backend restart cannot cancel its handoff.
export function releaseController({ home, code, restart }) {
  let restarting = false;
  const read = async () => {
    if (!home) return disabled;
    const canonicalHome = await NodeFSP.realpath(home);
    if (!code.startsWith(NodePath.join(canonicalHome, "releases") + "/")) return disabled;
    const current = await receipt(NodePath.join(code, "flow-release.json"));
    const prepared = await receipt(NodePath.join(canonicalHome, "current/flow-release.json"));
    return {
      supported: true,
      currentVersion: current.tag.slice(6),
      readyVersion: newerTag(prepared.tag, current.tag) ? prepared.tag.slice(6) : null,
      restarting,
    };
  };
  return {
    read,
    apply: async () => {
      const state = await read();
      if (!state.supported || !state.readyVersion)
        throw Error("No prepared Flow update is available.");
      if (!restarting) {
        restarting = true;
        try {
          await restart(() => {
            restarting = false;
          });
        } catch (error) {
          restarting = false;
          throw error;
        }
      }
      return { ...state, restarting };
    },
  };
}
