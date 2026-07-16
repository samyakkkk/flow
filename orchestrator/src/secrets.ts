// High-signal secret formats. Deliberately narrow: false positives can hide
// useful operational data, so only unambiguous credential formats belong here.
const SECRET_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{20,}\b/,                  // OpenAI/OpenRouter-style keys
  /\bxox[bapo]-[A-Za-z0-9-]{10,}\b/,            // Slack tokens
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,           // GitHub fine-grained PAT
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/,             // GitHub classic tokens
  /\blin_api_[A-Za-z0-9]{20,}\b/,               // Linear API keys
  /\bAKIA[0-9A-Z]{16}\b/,                       // AWS access key id
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,         // PEM private keys
];

export function containsSecret(text: string): boolean {
  return SECRET_PATTERNS.some((re) => re.test(text));
}

export function redactIfSecret(text: string): string {
  return containsSecret(text) ? "[redacted: possible credential]" : text;
}
