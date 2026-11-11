import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Next writes an AGENTS.md on dev startup. This app does not use that file.
  agentRules: false,
  // The dev server is opened at 127.0.0.1. Allow that host to load the client bundle.
  allowedDevOrigins: ["127.0.0.1"],
};

export default nextConfig;
