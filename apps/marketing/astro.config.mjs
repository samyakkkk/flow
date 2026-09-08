import { checkBranding } from "../../scripts/lib/check-branding.ts";
import BRAND from "../../branding.json" with { type: "json" };
import { defineConfig } from "astro/config";

checkBranding();

export default defineConfig({
  site: BRAND.links.website,
  server: {
    port: Number(process.env.PORT ?? 4173),
  },
});
