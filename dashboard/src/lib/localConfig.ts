// Per-project config store for integration keys (linear_key,
// slack_bot_token, slack_app_token, fireflies_key), encrypted at rest with
// AES-256-GCM. The key is derived from the PROJECT's admin token via scrypt,
// so local-config.json alone is useless without that project's .env — but
// note the honest threat model: anyone holding BOTH can decrypt. Keep data/
// out of backups and exports; rotate keys if either file leaks.
//
// Since the single-dashboard refactor the file lives per project at
// data/projects/<name>/local-config.json. Earlier builds wrote one shared
// file at dashboard/data/local-config.json (encrypted with whichever
// project's token that dashboard held — projects silently clobbered each
// other). On first read we migrate: any legacy entry that decrypts with THIS
// project's token belonged to this project and is copied over.
import fs from "node:fs";
import path from "node:path";
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import type { RegistryProject } from "./registry";

const LEGACY_CONFIG_FILE = path.join(process.cwd(), "data", "local-config.json");
const SCRYPT_SALT = "flow-local-config-v2";

function derivedKey(adminToken: string): Buffer {
  if (!adminToken) {
    throw new Error(
      "Project admin token is not set — refusing to store or read integration keys without an encryption key."
    );
  }
  return scryptSync(adminToken, SCRYPT_SALT, 32);
}

function encrypt(plain: string, adminToken: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", derivedKey(adminToken), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return `v2:${iv.toString("base64")}:${cipher.getAuthTag().toString("base64")}:${enc.toString("base64")}`;
}

function decrypt(stored: string, adminToken: string): string | null {
  const parts = stored.split(":");
  if (parts[0] !== "v2" || parts.length !== 4) return null; // unknown/legacy format
  try {
    const [, ivB64, tagB64, dataB64] = parts;
    const decipher = createDecipheriv("aes-256-gcm", derivedKey(adminToken), Buffer.from(ivB64, "base64"));
    decipher.setAuthTag(Buffer.from(tagB64, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(dataB64, "base64")), decipher.final()]).toString("utf8");
  } catch {
    return null; // wrong token or tampered file — fail closed, never return garbage
  }
}

interface LocalConfig {
  [key: string]: string;
}

function configFileFor(project: RegistryProject): string {
  return path.join(project.dir, "local-config.json");
}

function readEncrypted(file: string): Record<string, string> {
  try {
    if (!fs.existsSync(file)) return {};
    return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, string>;
  } catch {
    return {};
  }
}

// One-time migration from the pre-single-dashboard shared file: entries that
// decrypt with this project's token are this project's keys.
function migrateLegacy(project: RegistryProject): LocalConfig {
  const out: LocalConfig = {};
  for (const [k, v] of Object.entries(readEncrypted(LEGACY_CONFIG_FILE))) {
    const plain = decrypt(v, project.adminToken);
    if (plain !== null) out[k] = plain;
  }
  return out;
}

export function readLocalConfig(project: RegistryProject): LocalConfig {
  const file = configFileFor(project);
  if (!fs.existsSync(file)) {
    const migrated = migrateLegacy(project);
    if (Object.keys(migrated).length > 0) {
      writeLocalConfig(project, migrated);
      return migrated;
    }
    return {};
  }
  const out: LocalConfig = {};
  for (const [k, v] of Object.entries(readEncrypted(file))) {
    const plain = decrypt(v, project.adminToken);
    if (plain !== null) out[k] = plain;
  }
  return out;
}

export function writeLocalConfig(project: RegistryProject, updates: Record<string, string>): void {
  const file = configFileFor(project);
  const current = fs.existsSync(file)
    ? readLocalConfig(project)
    : migrateLegacy(project); // don't lose legacy entries on a first write
  const merged = { ...current, ...updates };
  const enc: Record<string, string> = {};
  for (const [k, v] of Object.entries(merged)) {
    enc[k] = encrypt(v, project.adminToken);
  }
  fs.writeFileSync(file, JSON.stringify(enc, null, 2), { encoding: "utf8", mode: 0o600 });
}
