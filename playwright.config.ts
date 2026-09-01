import { existsSync } from "node:fs";
import { defineConfig, devices } from "@playwright/test";

const installedChrome = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const chromiumExecutable =
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ??
  (existsSync(installedChrome) ? installedChrome : undefined);
const browserBaseURL =
  process.env.APKG_BROWSER_BASE_URL ??
  `http://127.0.0.1:${process.env.APKG_BROWSER_PORT ?? "4173"}/apkg-spike/`;
const browserPort = process.env.APKG_BROWSER_PORT ?? "4173";
const usesExternalBrowserServer = Boolean(process.env.APKG_BROWSER_BASE_URL);

export default defineConfig({
  testDir: "./tests/browser",
  fullyParallel: true,
  retries: 0,
  reporter: "list",
  use: {
    baseURL: browserBaseURL,
    browserName: "chromium",
    ...(chromiumExecutable
      ? { launchOptions: { executablePath: chromiumExecutable } }
      : {}),
    trace: "retain-on-failure",
  },
  ...(usesExternalBrowserServer
    ? {}
    : {
        webServer: {
          command: `vite --config vite.config.ts --host 127.0.0.1 --port ${browserPort}`,
          url: `http://127.0.0.1:${browserPort}/apkg-spike/`,
          reuseExistingServer: !process.env.CI,
          timeout: 30_000,
        },
      }),
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
