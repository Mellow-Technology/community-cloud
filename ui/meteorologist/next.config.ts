/**
 * @file
 * How Next builds Meteorologist.
 *
 * GUI Mellow ships its TypeScript and SCSS sources rather than a
 * build, so Next has to compile it as if it were part of this app.
 * The Kubernetes client stays outside the bundle: it reaches for Node
 * built-ins and optional modules at runtime that a bundler can't
 * follow, and it only ever runs on the server anyway.
 */
import type { NextConfig } from "next";

const config: NextConfig = {
  // A server.js and only the node_modules it needs, for the image
  output: "standalone",
  transpilePackages: ["gui-mellow"],
  serverExternalPackages: ["@kubernetes/client-node"],
  // Root imports from gui-mellow otherwise pull in every component's CSS
  experimental: { optimizePackageImports: ["gui-mellow"] },
  // next dev otherwise writes an AGENTS.md into the app on every start
  agentRules: false,
};

export default config;
