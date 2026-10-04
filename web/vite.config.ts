import fs from "node:fs";
import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// In development the server runs separately (npm run dev:server); proxy its
// REST API so the app uses the same paths it has when the server serves it.
// The server takes its port from the environment or the repo's .env, so read
// the same file here; variables already set still win. Keep the browser's Host
// header (Vite's string shorthand rewrites it to the target): the server's
// cross-site guard accepts an Origin only when it matches the requested host.
const envFile = path.resolve(import.meta.dirname, "../.env");
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);
const serverUrl = `http://localhost:${process.env.PORT?.trim() || 3000}`;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, "src") },
  },
  server: {
    proxy: { "/api": { target: serverUrl, changeOrigin: false } },
  },
});
