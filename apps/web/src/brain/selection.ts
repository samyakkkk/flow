const selectionKey = "flow.brain.selection";
export function readBrainSelection(): { brain?: string; environment?: string } {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(selectionKey) ?? "null");
    if (
      value &&
      typeof value === "object" &&
      "brain" in value &&
      "environment" in value &&
      typeof value.brain === "string" &&
      typeof value.environment === "string"
    )
      return { brain: value.brain, environment: value.environment };
  } catch {
    /* Storage may be unavailable in private windows. */
  }
  return {};
}
export function saveBrainSelection(brain: string | null, environment: string | null) {
  try {
    if (brain && environment)
      localStorage.setItem(selectionKey, JSON.stringify({ brain, environment }));
    else localStorage.removeItem(selectionKey);
  } catch {
    /* The URL remains authoritative without browser storage. */
  }
}
