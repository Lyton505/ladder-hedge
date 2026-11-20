import type { NextConfig } from "next";

/**
 * Next.js configuration.
 *
 * `cacheComponents` and `partialPrefetching` are explicitly off: they change
 * how route handlers are cached and prerendered, and the Gemini proxy routes
 * must always run at request time.
 *
 * `ws` (Gemini order-book WebSocket client) is loaded from node_modules at runtime
 * instead of being bundled, because its optional native add-ons break when bundled.
 */
const nextConfig: NextConfig = {
  cacheComponents: false,
  partialPrefetching: false,
  serverExternalPackages: ["ws"],
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
