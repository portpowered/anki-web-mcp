import { expect, test } from "@playwright/test";

test.describe("browser parser stack probe", () => {
  test("runs ZIP, SQLite/WASM, zstd, protobuf, and sanitizer operations in a Worker", async ({
    page,
  }) => {
    const externalRequests: string[] = [];
    const expectedOrigin = new URL(
      process.env.APKG_BROWSER_BASE_URL ??
        `http://127.0.0.1:${process.env.APKG_BROWSER_PORT ?? "4173"}/`,
    ).origin;
    page.on("request", (request) => {
      if (new URL(request.url()).origin !== expectedOrigin) {
        externalRequests.push(request.url());
      }
    });
    await page.goto("");
    const initialHeartbeat = Number(
      await page.locator("#heartbeat").getAttribute("data-heartbeat"),
    );

    await page.getByRole("button", { name: "Run stack evaluation" }).click();
    await expect(page.locator("#status")).toHaveAttribute(
      "data-status",
      "success",
      { timeout: 30_000 },
    );

    const output = JSON.parse(
      (await page.locator("#result").textContent()) ?? "null",
    ) as {
      cspViolationCount: number;
      mainThreadHeartbeat: number;
      workerRuntime: string;
      stagedResult: {
        zip: {
          entries: string[];
          collectionPayload: string;
          collectionSha256: string;
        };
        sqlite: { libraryVersion: string; rows: Array<{ id: number; value: string }> };
        zstd: { text: string; compressedBytes: number; decompressedBytes: number };
        protobuf: { decoded: { name: string; ordinal: number } };
        sanitizer: {
          output: string;
          removedUnsafeContent: boolean;
          retainsPackageMedia: boolean;
        };
      };
    };

    expect(output.workerRuntime).toBe("dedicated-worker");
    expect(output.cspViolationCount).toBe(0);
    expect(output.mainThreadHeartbeat).toBeGreaterThan(initialHeartbeat);
    expect(externalRequests).toEqual([]);

    expect(output.stagedResult.zip.entries).toEqual([
      "collection.anki2",
      "media",
    ]);
    expect(output.stagedResult.zip.collectionPayload).toBe(
      "browser Worker ZIP probe",
    );
    expect(output.stagedResult.zip.collectionSha256).toMatch(/^[0-9a-f]{64}$/);

    expect(output.stagedResult.sqlite.rows).toEqual([
      { id: 1, value: "legacy" },
      { id: 2, value: "current" },
    ]);
    expect(output.stagedResult.sqlite.libraryVersion).toMatch(/^3\.\d+/);

    expect(output.stagedResult.zstd.text).toBe("browser zstd probe");
    expect(output.stagedResult.zstd.compressedBytes).toBeGreaterThan(0);
    expect(output.stagedResult.zstd.decompressedBytes).toBe(18);

    expect(output.stagedResult.protobuf.decoded).toEqual({
      name: "current-media-map",
      ordinal: 7,
    });

    expect(output.stagedResult.sanitizer.removedUnsafeContent).toBe(true);
    expect(output.stagedResult.sanitizer.retainsPackageMedia).toBe(true);
    expect(output.stagedResult.sanitizer.output).toContain(
      "media://0",
    );
    expect(output.stagedResult.sanitizer.output).not.toContain("evil.invalid");
  });

  test("returns a cancellation terminal and no staged result", async ({ page }) => {
    await page.goto("?pauseAfterProgress=sqlite");
    await page.getByRole("button", { name: "Run stack evaluation" }).click();
    await expect(page.locator("#status")).toHaveAttribute("data-stage", "sqlite", {
      timeout: 10_000,
    });

    await page.getByRole("button", { name: "Cancel evaluation" }).click();
    await expect(page.locator("#status")).toHaveAttribute(
      "data-status",
      "cancelled",
      { timeout: 10_000 },
    );

    const output = JSON.parse(
      (await page.locator("#result").textContent()) ?? "null",
    ) as {
      status: string;
      commitReady: boolean;
      stagedResult: unknown;
      cancellation: string;
    };
    expect(output).toMatchObject({
      status: "cancelled",
      commitReady: false,
      stagedResult: null,
      cancellation: "cooperative-checkpoint",
    });

    const cancelledOutput = await page.locator("#result").textContent();
    await page.waitForTimeout(100);
    await expect(page.locator("#status")).toHaveAttribute(
      "data-status",
      "cancelled",
    );
    expect(await page.locator("#result").textContent()).toBe(cancelledOutput);
  });
});
