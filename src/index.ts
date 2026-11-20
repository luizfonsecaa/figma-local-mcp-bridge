import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { FigmaBridge } from "./bridge.js";
import { FIGMA_TOOLS, handleToolCall } from "./tools.js";

const bridge = new FigmaBridge();

const server = new Server(
  {
    name: "figma-bridge-mcp",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: FIGMA_TOOLS,
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const result = await handleToolCall(
    bridge,
    request.params.name,
    request.params.arguments
  );
  return {
    content: result.content,
    ...(result.isError ? { isError: true } : {}),
  };
});

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.error(`[figma-bridge] Shutting down (${signal})...`);
  try {
    await bridge.close();
  } catch (err) {
    console.error(
      `[figma-bridge] Error closing bridge: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  try {
    await server.close();
  } catch {
    // Ignore transport close error during shutdown
  }
  process.exit(0);
}

process.on("SIGINT", () => {
  void shutdown("SIGINT");
});
process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});
process.stdin.on("close", () => {
  void shutdown("stdin-close");
});
process.stdin.on("end", () => {
  void shutdown("stdin-end");
});

async function main(): Promise<void> {
  await bridge.start();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[figma-bridge] MCP server ready on stdio");
}

main().catch((err) => {
  console.error(
    `[figma-bridge] Fatal startup error: ${err instanceof Error ? err.stack ?? err.message : String(err)}`
  );
  process.exit(1);
});
