import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

import { webMcpOriginTrialToken } from "../lib/webmcp";

const exportDirectory = resolve(import.meta.dir, "../out");
const originTrialMetaPattern =
  /<meta\b[^>]*\bhttp-equiv="origin-trial"[^>]*>/i;

async function findHtmlFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const entryPath = join(directory, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await findHtmlFiles(entryPath)));
    } else if (entry.isFile() && entry.name.endsWith(".html")) {
      files.push(entryPath);
    }
  }

  return files;
}

function placeOriginTrialMetaBeforeScripts(html: string): string {
  const headEnd = html.indexOf("</head>");

  if (headEnd === -1) {
    throw new Error("Static document has no closing head element");
  }

  const head = html.slice(0, headEnd);
  const metaMatch = head.match(originTrialMetaPattern);

  if (
    !metaMatch ||
    !metaMatch[0].includes('content="' + webMcpOriginTrialToken + '"')
  ) {
    throw new Error(
      "Static document is missing the exact WebMCP origin-trial metadata",
    );
  }

  const headWithoutMeta = head.replace(metaMatch[0], "");
  const firstScript = headWithoutMeta.indexOf("<script");
  const insertionPoint =
    firstScript === -1 ? headWithoutMeta.length : firstScript;
  const reorderedHead =
    headWithoutMeta.slice(0, insertionPoint) +
    metaMatch[0] +
    headWithoutMeta.slice(insertionPoint);

  return reorderedHead + html.slice(headEnd);
}

const htmlFiles = await findHtmlFiles(exportDirectory);

if (htmlFiles.length === 0) {
  throw new Error("Static export did not contain any HTML documents");
}

for (const filePath of htmlFiles) {
  const html = await readFile(filePath, "utf8");
  const reorderedHtml = placeOriginTrialMetaBeforeScripts(html);

  if (reorderedHtml !== html) {
    await writeFile(filePath, reorderedHtml);
  }

  console.log("Prepared " + relative(exportDirectory, filePath));
}

const revision = Bun.spawnSync(["git", "rev-parse", "HEAD"], {
  cwd: resolve(import.meta.dir, ".."),
}).stdout.toString().trim();
if (!/^[0-9a-f]{40}$/u.test(revision)) {
  throw new Error("Static export revision must be an exact full Git SHA");
}
await writeFile(
  join(exportDirectory, "deployment-revision.json"),
  JSON.stringify({ schemaVersion: 1, revision }) + "\n",
);
