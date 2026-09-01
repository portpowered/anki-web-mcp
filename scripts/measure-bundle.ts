import { mkdir, rm, readdir, writeFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { join, relative, resolve } from "node:path";
import { build } from "vite";

const repositoryRoot = resolve(import.meta.dir, "..");
const spikeRoot = join(repositoryRoot, "spikes", "apkg-compatibility");
const outputRoot = join(repositoryRoot, ".artifacts", "bundle-measure");
const stackOutput = join(outputRoot, "stack");
const baselineOutput = join(outputRoot, "baseline");

await rm(outputRoot, { recursive: true, force: true });

await buildBundle(join(spikeRoot, "index.html"), stackOutput);
await buildBundle(join(spikeRoot, "measure-baseline.html"), baselineOutput);

const stack = await measureAssets(stackOutput);
const baseline = await measureAssets(baselineOutput);
const report = {
  command: "bun run measure:bundle",
  inputs: {
    stack: "spikes/apkg-compatibility/index.html",
    baseline: "spikes/apkg-compatibility/measure-baseline.html",
  },
  stack,
  baseline,
  incremental: {
    uncompressedBytes: stack.uncompressedBytes - baseline.uncompressedBytes,
    gzipBytes: stack.gzipBytes - baseline.gzipBytes,
  },
};

await mkdir(outputRoot, { recursive: true });
await writeFile(
  join(outputRoot, "report.json"),
  `${JSON.stringify(report, null, 2)}\n`,
);
console.log(JSON.stringify(report, null, 2));

async function buildBundle(input: string, outDir: string): Promise<void> {
  await build({
    configFile: join(repositoryRoot, "vite.config.ts"),
    root: spikeRoot,
    base: "/apkg-spike/",
    build: {
      assetsInlineLimit: 0,
      emptyOutDir: true,
      outDir,
      rollupOptions: { input },
      sourcemap: false,
      target: "es2022",
    },
  });
}

async function measureAssets(directory: string): Promise<{
  files: Array<{ path: string; bytes: number; gzipBytes: number }>;
  uncompressedBytes: number;
  gzipBytes: number;
}> {
  const files: Array<{ path: string; bytes: number; gzipBytes: number }> = [];
  const entries = await readdir(directory, { recursive: true });

  for (const entry of entries) {
    const path = join(directory, entry);
    if (!/\.(?:js|mjs|wasm)$/.test(path)) {
      continue;
    }

    const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
    files.push({
      path: relative(repositoryRoot, path).replaceAll("\\", "/"),
      bytes: bytes.byteLength,
      gzipBytes: gzipSync(bytes, { level: 9 }).byteLength,
    });
  }

  files.sort((left, right) => left.path.localeCompare(right.path));
  return {
    files,
    uncompressedBytes: files.reduce((total, file) => total + file.bytes, 0),
    gzipBytes: files.reduce((total, file) => total + file.gzipBytes, 0),
  };
}
