import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Port 5173 (the CLI --port overrides it). /api is proxied to the desk API (task G1) on 127.0.0.1:4020.
// Mock mode (VITE_MOCK=1 or ?mock=1) never touches the proxy.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: { "/api": { target: process.env.NT_DESK_API_URL ?? "http://127.0.0.1:4020", changeOrigin: false } }, // NT_DESK_API_URL: point at a desk API on another port
  },
  test: { include: ["test/**/*.test.ts"] },
});
