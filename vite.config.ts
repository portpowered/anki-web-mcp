import { defineConfig } from "vite";

export default defineConfig({
  base: "/apkg-spike/",
  root: "spikes/apkg-compatibility",
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
