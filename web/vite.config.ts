import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// In development the server runs separately (npm run dev:server); proxy its
// REST API so the app uses the same paths it has when the server serves it.
const serverUrl = process.env.DEV_SERVER_URL ?? "http://localhost:3000";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, "src") },
  },
  server: {
    proxy: { "/api": serverUrl },
  },
});
