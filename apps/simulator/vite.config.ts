import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, type PluginOption } from "vite";

/**
 * The simulator's dev server, and the MCP server it talks to.
 *
 * The simulator is a **host**, not a mock. It holds no product knowledge: every
 * sentence it shows and every card it draws came out of a tool result it
 * received over Streamable HTTP. So it needs a real CIRCA server on the other
 * end of a real socket, and this plugin starts one — as a separate process, on
 * its own port, exactly the way Alexa+ would reach a self-hosted add-on.
 *
 * Running it in-process would have been fewer moving parts and would also have
 * made the transport a lie: an in-process server shares the module graph with
 * its client, and a client that can reach its server's memory is not exercising
 * a transport at all.
 *
 * `CIRCA_MCP_URL` points the simulator at a server that is already running
 * (a deployment, or `pnpm mcp` in another terminal) and skips the spawn.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../..");

const externalUrl = process.env["CIRCA_MCP_URL"];
const serverPort = Number(process.env["CIRCA_PORT"] ?? 8787);
const target = externalUrl ?? `http://127.0.0.1:${serverPort}`;

async function waitForHealth(url: string, timeoutMs = 20_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/health`);
      if (response.ok) return true;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

function circaServer(): PluginOption {
  let child: ChildProcess | undefined;
  const stopChild = (): void => {
    child?.kill();
    child = undefined;
  };
  return {
    name: "circa-mcp-server",
    apply: "serve",
    async configureServer(server) {
      if (externalUrl) {
        server.config.logger.info(`  ➜  CIRCA:   using the server already at ${externalUrl}`);
        return;
      }
      child = spawn(process.execPath, ["node_modules/tsx/dist/cli.mjs", "apps/mcp-server/src/main.ts"], {
        cwd: REPO_ROOT,
        env: { ...process.env, CIRCA_PORT: String(serverPort) },
        stdio: ["ignore", "pipe", "inherit"],
      });
      // The server's own banner names the protocol version and the store, which
      // are the first two things anyone wants to know, so it is passed through
      // rather than swallowed.
      child.stdout?.on("data", (chunk: Buffer) => {
        process.stdout.write(chunk.toString().replace(/^/gm, "  "));
      });
      const up = await waitForHealth(target);
      if (!up) {
        // Loudly, and stop. A warning here was survivable in a terminal and
        // invisible in a recording: the page came up, the cards never did, and
        // the reason was one line of scrollback above the URL.
        stopChild();
        throw new Error(
          `CIRCA's MCP server did not answer /health at ${target}. Something else may be holding port ${serverPort}: ` +
            `run with CIRCA_PORT set to a free port, or stop that process.`,
        );
      }

      server.httpServer?.on("close", stopChild);
      process.on("exit", stopChild);
    },
    closeBundle() {
      stopChild();
    },
  };
}

export default defineConfig({
  root: HERE,
  plugins: [react(), circaServer()],
  server: {
    port: Number(process.env["CIRCA_SIMULATOR_PORT"] ?? 5173),
    // Same origin for the MCP endpoint, so the SDK's client runs in the browser
    // with no CORS shim in the way. What the browser sends is what a host sends.
    proxy: {
      "/mcp": { target, changeOrigin: true },
      "/health": { target, changeOrigin: true },
      "/metrics": { target, changeOrigin: true },
    },
  },
  build: {
    outDir: path.resolve(REPO_ROOT, "dist/simulator"),
    emptyOutDir: true,
  },
});
