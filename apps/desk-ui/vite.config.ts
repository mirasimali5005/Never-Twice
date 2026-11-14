import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Port 5173. /api is proxied to the desk API (task G1) on 127.0.0.1:4020.
// Mock mode (VITE_MOCK=1 or ?mock=1) never touches the proxy.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: { "/api": { target: "http://127.0.0.1:4020", changeOrigin: false } },
  },
  test: { include: ["test/**/*.test.ts"] },
});
