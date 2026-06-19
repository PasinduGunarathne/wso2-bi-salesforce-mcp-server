import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { registerOAuthTools } from "./tools/oauth.js";
import { registerSalesforceTools } from "./tools/salesforce.js";
import { registerBallerinaTools } from "./tools/ballerina.js";
import { registerPostmanTools } from "./tools/postman.js";
import { getServerVersion } from "./constants.js";

// ─── Server factory ───────────────────────────────────────────────────────────

const SERVER_NAME = "ballerina-salesforce-mcp-server";
const SERVER_VERSION = getServerVersion();

/**
 * Creates a fully-configured McpServer instance.
 * Called once for stdio mode, and once *per request* in HTTP mode so that
 * each stateless request gets its own server+transport pair — avoiding the
 * race condition that arises when multiple concurrent requests share a single
 * server instance and overwrite each other's active transport.
 */
function createServer(): McpServer {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });
  registerOAuthTools(server);
  registerSalesforceTools(server);
  registerBallerinaTools(server);
  registerPostmanTools(server);
  return server;
}

// ─── Transport ────────────────────────────────────────────────────────────────

async function runStdio(): Promise<void> {
  const transport = new StdioServerTransport();
  await createServer().connect(transport);
  console.error(`${SERVER_NAME} v${SERVER_VERSION} running on stdio`);
}

async function runHTTP(): Promise<void> {
  // Lazy-import express so stdio users (the common case) don't pay for it.
  const { default: express } = await import("express");
  const app = express();
  app.use(express.json());

  // Optional shared-secret auth. Set SF_MCP_HTTP_TOKEN to require clients to
  // present `Authorization: Bearer <token>`. Strongly recommended for any
  // host beyond pure localhost development.
  const requiredToken = process.env.SF_MCP_HTTP_TOKEN;
  if (!requiredToken) {
    console.error(
      "WARNING: SF_MCP_HTTP_TOKEN not set — HTTP transport will accept unauthenticated requests. " +
        "Set this env var to a strong random value for any non-trivial deployment."
    );
  }

  app.post("/mcp", async (req, res) => {
    if (requiredToken) {
      const header = req.header("authorization") ?? "";
      const presented = header.replace(/^Bearer\s+/i, "");
      if (presented !== requiredToken) {
        res.status(401).json({ error: "unauthorized" });
        return;
      }
    }

    // A fresh McpServer is created per request (stateless mode).
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => transport.close());
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body as Record<string, unknown>);
  });

  app.get("/healthz", (_req, res) => {
    res.json({ status: "ok", name: SERVER_NAME, version: SERVER_VERSION });
  });

  const port = parseInt(process.env.PORT ?? "3001", 10);
  app.listen(port, "127.0.0.1", () => {
    console.error(
      `${SERVER_NAME} v${SERVER_VERSION} running on http://127.0.0.1:${port}/mcp ` +
        `(auth: ${requiredToken ? "enabled" : "DISABLED"})`
    );
  });
}

// ─── Entry ────────────────────────────────────────────────────────────────────

const transport = process.env.TRANSPORT ?? "stdio";

if (transport === "http") {
  runHTTP().catch((err: unknown) => {
    console.error("Server error:", err);
    process.exit(1);
  });
} else {
  runStdio().catch((err: unknown) => {
    console.error("Server error:", err);
    process.exit(1);
  });
}
