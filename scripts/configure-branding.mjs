import * as NodeFSP from "node:fs/promises";
import * as NodeURL from "node:url";
import * as NodePath from "node:path";
import sharp from "sharp";
import { encodePngIco, WINDOWS_ICON_SIZES } from "./lib/icon-export.ts";
import {
  brandingFingerprint,
  escapeXml,
  mergeBranding,
  renderBrandSvg,
  validateBranding,
} from "./lib/branding-config.ts";

const root = NodeURL.fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
if (
  args.length &&
  !(args.length === 2 && args[0] === "--config") &&
  !(args.length === 1 && args[0] === "--check")
) {
  throw new Error(
    "Usage: node scripts/configure-branding.mjs [--config enterprise.json | --check]",
  );
}
const original = JSON.parse(await NodeFSP.readFile(NodePath.join(root, "branding.json"), "utf8"));
const config =
  args[0] === "--config"
    ? mergeBranding(original, JSON.parse(await NodeFSP.readFile(NodePath.resolve(args[1]), "utf8")))
    : validateBranding(original);
const readArtwork = async (source) =>
  NodeFSP.readFile(NodePath.join(root, source)).catch((error) => {
    if (error.code === "ENOENT") {
      throw new Error(`Brand artwork source is missing: ${source}`);
    }
    throw error;
  });
const iconSource = await readArtwork(config.icon.source);
const wordmarkOnLightSource = await readArtwork(config.wordmark.onLightSource);
const wordmarkOnDarkSource = await readArtwork(config.wordmark.onDarkSource);
const outputs = new Map();
const png = async (size, source = iconSource) =>
  sharp(typeof source === "string" ? Buffer.from(source) : source)
    .resize(size, size, { fit: "cover" })
    .png()
    .toBuffer();
const icon = await png(1024);
outputs.set("assets/brand/icon.png", icon);
for (const name of ["icon", "icon-nightly"])
  outputs.set(`apps/marketing/src/assets/${name}.webp`, await sharp(icon).webp().toBuffer());
const ico = encodePngIco(
  await Promise.all(WINDOWS_ICON_SIZES.map(async (size) => ({ size, contents: await png(size) }))),
);
outputs.set("assets/brand/icon.ico", ico);
for (const dir of ["assets/brand", "apps/web/public", "apps/marketing/public"]) {
  outputs.set(`${dir}/favicon.ico`, ico);
  outputs.set(`${dir}/favicon-16x16.png`, await png(16));
  outputs.set(`${dir}/favicon-32x32.png`, await png(32));
  outputs.set(`${dir}/apple-touch-icon.png`, await png(180));
}
for (const dir of ["apps/web/public", "apps/marketing/public"]) {
  outputs.set(`${dir}/brand-wordmark-on-light.svg`, wordmarkOnLightSource);
  outputs.set(`${dir}/brand-wordmark-on-dark.svg`, wordmarkOnDarkSource);
}
const wordmarkPng = async (source) => sharp(source).resize({ height: 256 }).png().toBuffer();
outputs.set(
  "apps/mobile/assets/brand-wordmark-on-light.png",
  await wordmarkPng(wordmarkOnLightSource),
);
outputs.set(
  "apps/mobile/assets/brand-wordmark-on-dark.png",
  await wordmarkPng(wordmarkOnDarkSource),
);
outputs.set(
  "apps/web/public/manifest.webmanifest",
  JSON.stringify(
    {
      id: "/",
      name: config.name,
      short_name: config.shortName,
      description: config.description,
      start_url: "/",
      scope: "/",
      display: "standalone",
      background_color: config.colors.background,
      theme_color: config.colors.background,
      icons: [{ src: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
    },
    null,
    2,
  ) + "\n",
);
const markSvg = renderBrandSvg(config, { background: false });
outputs.set("apps/mobile/assets/android-icon-foreground.png", await png(1024, markSvg));
outputs.set("apps/mobile/assets/android-icon-mark.png", await png(432, markSvg));
outputs.set("apps/mobile/assets/android-notification-icon.png", await png(96, markSvg));
outputs.set(
  "apps/mobile/assets/widget/T3Mark.svg",
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${escapeXml(config.mark.viewBox)}"><path d="${escapeXml(config.mark.path)}" fill="#FFFFFF"/></svg>\n`,
);
for (const channel of ["latest", "nightly"]) {
  outputs.set(
    `apps/desktop/resources/dmg/dmg-background-${channel}.svg`,
    `<svg xmlns="http://www.w3.org/2000/svg" width="540" height="380" viewBox="0 0 540 380"><rect width="540" height="380" fill="#f4f4f5"/><text x="270" y="60" text-anchor="middle" font-family="sans-serif" font-size="26" fill="#18181b">${escapeXml(config.name)}</text><path d="M240 190H300M285 175L300 190L285 205" stroke="#71717a" fill="none" stroke-width="3"/><text x="270" y="322" text-anchor="middle" font-family="sans-serif" font-size="13" fill="#18181b">Drag ${escapeXml(config.name)} to Applications</text></svg>\n`,
  );
}
const desktopPackage = JSON.parse(
  await NodeFSP.readFile(NodePath.join(root, "apps/desktop/package.json"), "utf8"),
);
outputs.set(
  "apps/desktop/package.json",
  JSON.stringify({ ...desktopPackage, productName: config.name }, null, 2) + "\n",
);
outputs.set(
  "assets/brand/fingerprint",
  brandingFingerprint(config, [iconSource, wordmarkOnLightSource, wordmarkOnDarkSource]) + "\n",
);
const stale = [];
for (const [relative, contents] of outputs) {
  const target = NodePath.join(root, relative);
  const expected = Buffer.from(contents);
  const current = await NodeFSP.readFile(target).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (current?.equals(expected)) continue;
  if (args[0] === "--check") {
    stale.push(relative);
    continue;
  }
  await NodeFSP.mkdir(NodePath.dirname(target), { recursive: true });
  await NodeFSP.writeFile(target, expected);
}
if (stale.length)
  throw new Error(`Brand assets are stale. Run pnpm branding:generate.\n${stale.join("\n")}`);
if (args[0] === "--config")
  await NodeFSP.writeFile(
    NodePath.join(root, "branding.json"),
    JSON.stringify(config, null, 2) + "\n",
  );
console.log(
  args[0] === "--check"
    ? "Brand assets are current."
    : `Generated ${config.name} branding. Rebuild the deployment to apply it.`,
);
