import { fileURLToPath } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

// The browser talks only to the indexer API. In dev, /api is proxied to it so no CORS setup is needed;
// in production set VITE_API_URL to the API origin.
export default defineConfig(({ mode }) => {
  // Also reads apps/web/.env*; MANDATE_API_PROXY is dev-server config and is never sent to the browser.
  const env = { ...loadEnv(mode, import.meta.dirname, ""), ...process.env };
  return {
    plugins: [react(), tailwindcss()],
    resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
    server: {
      port: 5173,
      proxy: {
        "/api": {
          target: env.MANDATE_API_PROXY ?? "http://127.0.0.1:8787",
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api/, ""),
        },
      },
    },
  };
});
