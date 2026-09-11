// lib/ports.mjs — Port allocation logic for multi-project setup.
//
// Base ports (from spec):
//   gateway      7433 + 10 * projectIndex
//   orchestrator 7500 + 10 * projectIndex
//   dashboard    7600  (ONE dashboard for the whole deployment; the per-index
//                       dashboard slot is still allocated for legacy cleanup)
//
// projectIndex is the ordinal position of the project in the sorted project list.
//
// FLOW_PORT_OFFSET shifts every base — for running a second deployment (e.g.
// tests) beside a live one without port collisions.

const OFFSET = Number(process.env.FLOW_PORT_OFFSET ?? 0) || 0;

export const BASE_GATEWAY = 7433 + OFFSET;
export const BASE_ORCHESTRATOR = 7500 + OFFSET;
export const BASE_DASHBOARD = 7600 + OFFSET;
export const PORT_STRIDE = 10;

/**
 * Return {gateway, orchestrator, dashboard} ports for a given project index.
 * @param {number} index  0-based index into the sorted project list
 */
export function portsForIndex(index) {
  return {
    gateway: BASE_GATEWAY + PORT_STRIDE * index,
    orchestrator: BASE_ORCHESTRATOR + PORT_STRIDE * index,
    dashboard: BASE_DASHBOARD + PORT_STRIDE * index,
  };
}

/** The single deployment-wide dashboard port. */
export function dashboardPort() {
  return BASE_DASHBOARD;
}
