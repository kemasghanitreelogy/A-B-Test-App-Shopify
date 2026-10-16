import type { NextConfig } from "next";

// The build always runs from dashboard/. Pinning the tracing and Turbopack root
// here stops Next from picking up the root repo's lockfile as the workspace
// root, which would nest server.js under .next/standalone/dashboard/.
const root = process.cwd();

const nextConfig: NextConfig = {
  // The VPS runs `node server.js` from the standalone output, not `next start`.
  output: "standalone",
  outputFileTracingRoot: root,
  turbopack: { root },
  // Set by the deploy script to the git SHA. Blue/green switches leave tabs
  // open on the previous release; a mismatched id makes Next do a hard
  // navigation instead of calling Server Actions the new build doesn't have.
  deploymentId: process.env.NEXT_DEPLOYMENT_ID || undefined,
};

export default nextConfig;
