import { fileURLToPath } from "node:url";
import { startServer } from "./app";

// In dev the web server owns PORT (Vite proxies /ws to us), so only SERVER_PORT applies.
const dev = process.argv.includes("--dev");
const port = Number(process.env.SERVER_PORT ?? (dev ? undefined : process.env.PORT) ?? 8790);
const staticDir = fileURLToPath(new URL("../dist", import.meta.url));

const server = await startServer({ port, staticDir });
console.log(`[collab-board] listening on http://localhost:${server.port} (ws: /ws)`);
