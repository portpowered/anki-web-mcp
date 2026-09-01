import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "export",
  basePath: process.env.PAGES_BASE_PATH ?? "/anki-web-mcp",
  trailingSlash: true,
  images: {
    unoptimized: true,
  },
};

export default nextConfig;
