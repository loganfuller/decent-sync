import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { type Plugin, defaultClientConditions, defineConfig } from "vite";

// In development the server runs separately (npm run dev:server); proxy its
// REST API so the app uses the same paths it has when the server serves it.
// The server takes its port from the environment or the repo's .env, so read
// the same file here; variables already set still win. Keep the browser's Host
// header (Vite's string shorthand rewrites it to the target): the server's
// cross-site guard accepts an Origin only when it matches the requested host.
const envFile = path.resolve(import.meta.dirname, "../.env");
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);
const serverUrl = `http://localhost:${process.env.PORT?.trim() || 3000}`;

/**
 * Names the build in its index.html, as `<meta name="decent-sync-build">`: the
 * page reads it as its own build, and the server sends it in every response's
 * Decent-Sync-Build header (`src/lib/build.ts`, ADR-0025). The name hashes
 * index.html and the names of the files the build wrote, which hash their
 * contents, so every copy of one build has the same name, and a build that
 * changes anything a page loads has another. `npm run dev:web` names none.
 */
function nameBuild(): Plugin {
  return {
    name: "decent-sync:name-build",
    apply: "build",
    transformIndexHtml: {
      order: "post",
      handler(html, { bundle }) {
        const hash = createHash("sha256").update(html);
        for (const fileName of Object.keys(bundle ?? {}).sort()) hash.update(`\0${fileName}`);
        return [{ tag: "meta", attrs: { name: "decent-sync-build", content: hash.digest("hex").slice(0, 16) }, injectTo: "head" }];
      },
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), nameBuild()],
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, "src") },
    // The protocol package's TypeScript source, as esbuild, TypeScript and Vitest take it, so the app needs no protocol build.
    conditions: ["@decent-sync/source", ...defaultClientConditions],
  },
  server: {
    proxy: { "/api": { target: serverUrl, changeOrigin: false } },
  },
});
