import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

const SERVER_PORT = Number(process.env.SERVER_PORT ?? 8790);

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5180,
    strictPort: true,
    proxy: {
      "/ws": { target: `ws://localhost:${SERVER_PORT}`, ws: true },
    },
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
