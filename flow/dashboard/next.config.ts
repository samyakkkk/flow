import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Disable server-side static generation for pages that read session cookies
  // (handled via middleware and cookie checks at runtime)
  experimental: {},
  // Do not expose source maps in production builds
  productionBrowserSourceMaps: false,
};

export default nextConfig;
