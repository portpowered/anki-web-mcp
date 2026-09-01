import type { Metadata } from "next";
import "./globals.css";

import { assetPath } from "../lib/site";
import { webMcpOriginTrialToken } from "../lib/webmcp";

export const metadata: Metadata = {
  title: "WebMCP Anki",
  description: "A static-export foundation for the WebMCP Anki harness.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <head>
        <meta httpEquiv="origin-trial" content={webMcpOriginTrialToken} />
        <link rel="icon" href={assetPath("/diagnostic-mark.svg")} />
      </head>
      <body>{children}</body>
    </html>
  );
}
