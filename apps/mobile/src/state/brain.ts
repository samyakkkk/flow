import { requestBrain } from "@t3tools/client-runtime/state/brain";
import { createEnvironmentCommand } from "@t3tools/client-runtime/state/runtime";
import { connectionAtomRuntime } from "../connection/runtime";
export const brainCommand = createEnvironmentCommand(connectionAtomRuntime, {
  label: "brain",
  execute: requestBrain,
});
