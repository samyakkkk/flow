// Dashboard-local config store for integration keys (linear_key,
// slack_bot_token, slack_app_token, fireflies_key), encrypted at rest with
// AES-256-GCM. The key is derived from FLOW_ADMIN_TOKEN via scrypt, so
// local-config.json alone is useless without the admin token — but note the
// honest threat model: anyone holding BOTH .env and this file can decrypt.
// Keep data/ out of backups and exports; rotate keys if either file leaks.
import fs from "node:fs";
import path from "node:path";
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { FLOW_ADMIN_TOKEN } from "./config";

const DATA_DIR = path.join(process.cwd(), "data");
const CONFIG_FILE = path.join(DATA_DIR, "local-config.json");
const SCRYPT_SALT = "flow-local-config-v2";

function derivedKey(): Buffer {
  if (!FLOW_ADMIN_TOKEN) {
    throw new Error(
      "FLOW_ADMIN_TOKEN is not set — refusing to store or read integration keys without an encryption key."
    );
  }
  return scryptSync(FLOW_ADMIN_TOKEN, SCRYPT_SALT, 32);
}

function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", derivedKey(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return `v2:${iv.toString("base64")}:${cipher.getAuthTag().toString("base64")}:${enc.toString("base64")}`;
}

function decrypt(stored: string): string | null {
  const parts = stored.split(":");
  if (parts[0] !== "v2" || parts.length !== 4) return null; // unknown/legacy format
  try {
    const [, ivB64, tagB64, dataB64] = parts;
    const decipher = createDecipheriv("aes-256-gcm", derivedKey(), Buffer.from(ivB64, "base64"));
    decipher.setAuthTag(Buffer.from(tagB64, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(dataB64, "base64")), decipher.final()]).toString("utf8");
  } catch {
    return null; // wrong token or tampered file — fail closed, never return garbage
  }
}

interface LocalConfig {
  [key: string]: string;
}

export function readLocalConfig(): LocalConfig {
  try {
    if (!fs.existsSync(CONFIG_FILE)) return {};
    const enc = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")) as Record<string, string>;
    const out: LocalConfig = {};
    for (const [k, v] of Object.entries(enc)) {
      const plain = decrypt(v);
      if (plain !== null) out[k] = plain;
    }
    return out;
  } catch {
    return {};
  }
}

export function writeLocalConfig(updates: Record<string, string>): void {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const current = readLocalConfig();
  const merged = { ...current, ...updates };
  const enc: Record<string, string> = {};
  for (const [k, v] of Object.entries(merged)) {
    enc[k] = encrypt(v);
  }
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(enc, null, 2), { encoding: "utf8", mode: 0o600 });
}
