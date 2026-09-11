// lib/health.mjs — HTTP health-check utilities.

/**
 * Probe a /health endpoint. Returns true if it responds with status 200.
 * Timeout defaults to 2000ms.
 * @param {string} url  Full URL to probe (e.g. "http://localhost:7500/health")
 * @param {number} timeoutMs
 */
export async function probe(url, timeoutMs = 2000) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Wait for a /health endpoint to respond, up to maxWaitMs.
 * Polls every intervalMs.
 */
export async function waitForHealth(url, maxWaitMs = 20000, intervalMs = 400) {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    if (await probe(url)) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}
