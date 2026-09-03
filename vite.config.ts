import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { delimiter } from "node:path";
import { defineConfig } from "vite";

const realPackagePaths = (process.env.ANKI_REAL_APKG_PATHS ?? "")
  .split(delimiter)
  .map((value) => value.trim())
  .filter(Boolean);

export default defineConfig({
  base: "/apkg-spike/",
  root: "spikes/apkg-compatibility",
  plugins: [{
    name: "local-real-apkg-regression-corpus",
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const match = /\/__real-apkg__\/(\d+)$/.exec(request.url ?? "");
        const packagePath = match ? realPackagePaths[Number(match[1])] : undefined;
        if (!packagePath) {
          next();
          return;
        }
        try {
          const metadata = await stat(packagePath);
          response.writeHead(200, {
            "Content-Length": metadata.size,
            "Content-Type": "application/octet-stream",
          });
          const stream = createReadStream(packagePath);
          stream.on("error", next);
          stream.pipe(response);
        } catch (error) {
          next(error);
        }
      });
    },
  }],
  build: {
    assetsInlineLimit: 0,
    emptyOutDir: true,
    outDir: "../../dist/apkg-spike",
    sourcemap: false,
    target: "es2022",
  },
  server: {
    headers: {
      "Content-Security-Policy": [
        "default-src 'self'",
        "script-src 'self' 'wasm-unsafe-eval'",
        "worker-src 'self'",
        "connect-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data:",
        "media-src 'self' blob:",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'none'",
      ].join("; "),
    },
  },
});
