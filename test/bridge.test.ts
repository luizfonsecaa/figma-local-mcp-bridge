import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { WebSocket } from "ws";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
const SERVER_ENTRY = path.join(PROJECT_ROOT, "build", "index.js");
const TEST_PORT = 3955;

// Valid 1x1 transparent PNG
const SAMPLE_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
const SAMPLE_SVG =
  '<svg width="24" height="24" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M4 12h16" stroke="#111827"/></svg>';

const EXPECTED_TOOLS = [
  "figma_get_status",
  "figma_get_document_info",
  "figma_get_selection",
  "figma_get_node",
  "figma_get_page_structure",
  "figma_search_nodes",
  "figma_get_styles",
  "figma_get_variables",
  "figma_get_components",
  "figma_export_node",
];

function buildFixtures() {
  const variablesPayload = {
    collections: [
      {
        id: "VariableCollectionId:1:1",
        name: "Semantic",
        defaultModeId: "1:0",
        modes: [
          { modeId: "1:0", name: "Light" },
          { modeId: "1:1", name: "Dark" },
        ],
      },
      {
        id: "VariableCollectionId:2:1",
        name: "Primitives",
        defaultModeId: "2:0",
        modes: [{ modeId: "2:0", name: "Default" }],
      },
    ],
    variables: [
      {
        id: "VariableID:2:10",
        name: "Palette/Blue/500",
        collectionId: "VariableCollectionId:2:1",
        collectionName: "Primitives",
        resolvedType: "COLOR",
        scopes: ["ALL_FILLS"],
        valuesByMode: {
          "2:0": {
            modeId: "2:0",
            modeName: "Default",
            rawValue: { r: 0.2314, g: 0.5098, b: 0.9647, a: 1 },
            resolvedValue: { hex: "#3b82f6", r: 0.2314, g: 0.5098, b: 0.9647, a: 1 },
          },
        },
      },
      {
        id: "VariableID:1:10",
        name: "Surface/Brand",
        collectionId: "VariableCollectionId:1:1",
        collectionName: "Semantic",
        resolvedType: "COLOR",
        description: "Primary interactive surface",
        scopes: ["FRAME_FILL", "SHAPE_FILL"],
        valuesByMode: {
          "1:0": {
            modeId: "1:0",
            modeName: "Light",
            rawValue: { type: "VARIABLE_ALIAS", id: "VariableID:2:10" },
            resolvedValue: { hex: "#3b82f6", r: 0.2314, g: 0.5098, b: 0.9647, a: 1 },
            aliasTo: {
              id: "VariableID:2:10",
              name: "Palette/Blue/500",
              collectionName: "Primitives",
            },
          },
          "1:1": {
            modeId: "1:1",
            modeName: "Dark",
            rawValue: { r: 0.1137, g: 0.3059, b: 0.8471, a: 1 },
            resolvedValue: { hex: "#1d4ed8", r: 0.1137, g: 0.3059, b: 0.8471, a: 1 },
          },
        },
      },
      {
        id: "VariableID:1:11",
        name: "Spacing/Md",
        collectionId: "VariableCollectionId:1:1",
        collectionName: "Semantic",
        resolvedType: "FLOAT",
        scopes: ["GAP"],
        valuesByMode: {
          "1:0": {
            modeId: "1:0",
            modeName: "Light",
            rawValue: 16,
            resolvedValue: 16,
          },
          "1:1": {
            modeId: "1:1",
            modeName: "Dark",
            rawValue: 16,
            resolvedValue: 16,
          },
        },
      },
    ],
  };

  const sampleCardNode = {
    id: "10:1",
    name: "HeroCard",
    type: "FRAME",
    bounds: { x: 0, y: 0, width: 400, height: 240 },
    autoLayout: {
      layoutMode: "VERTICAL",
      primaryAxisAlignItems: "MIN",
      counterAxisAlignItems: "MIN",
      primaryAxisSizingMode: "FIXED",
      counterAxisSizingMode: "AUTO",
      itemSpacing: 16,
      padding: { top: 24, right: 24, bottom: 24, left: 24 },
    },
    cornerRadius: 12,
    css: {
      display: "flex",
      "flex-direction": "column",
      padding: "24px",
      gap: "16px",
      "border-radius": "12px",
    },
    children: [
      {
        id: "10:2",
        name: "Title",
        type: "TEXT",
        bounds: { x: 24, y: 24, width: 352, height: 32 },
        text: {
          characters: "Dashboard Overview",
          fontSize: 24,
          fontWeight: 700,
        },
      },
      {
        id: "10:3",
        name: "ArrowIcon",
        type: "VECTOR",
        bounds: { x: 24, y: 72, width: 24, height: 24 },
        isIconCandidate: true,
      },
    ],
  };

  return {
    variablesPayload,
    sampleCardNode,
  };
}

class MockFigmaPlugin {
  private ws: WebSocket | null = null;
  public readonly clientId = "figma-mock-tab-1";
  private readonly fixtures = buildFixtures();

  public async connect(port: number): Promise<void> {
    await this.close();

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://localhost:${port}`, {
        maxPayload: 50 * 1024 * 1024,
      });

      const cleanupStartup = () => {
        ws.off("error", onErr);
      };

      const onErr = (err: Error) => {
        cleanupStartup();
        reject(err);
      };

      ws.once("error", onErr);

      ws.once("open", () => {
        ws.send(
          JSON.stringify({
            type: "hello",
            role: "figma-plugin",
            clientId: this.clientId,
            file: {
              name: "Design System App",
              currentPage: { id: "0:1", name: "Screens" },
              selectionCount: 1,
            },
          })
        );
      });

      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString("utf8")) as {
          type: string;
          id?: string;
          method?: string;
          params?: Record<string, unknown>;
        };

        if (msg.type === "hello-ack") {
          cleanupStartup();
          this.ws = ws;
          resolve();
          return;
        }

        if (msg.type === "request" && msg.id && msg.method) {
          try {
            const result = this.handleMethod(msg.method, msg.params ?? {});
            ws.send(
              JSON.stringify({
                type: "response",
                id: msg.id,
                ok: true,
                result,
              })
            );
          } catch (err) {
            ws.send(
              JSON.stringify({
                type: "response",
                id: msg.id,
                ok: false,
                error: err instanceof Error ? err.message : String(err),
              })
            );
          }
        }
      });
    });
  }

  public sendStatusUpdate(selectionCount: number): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(
        JSON.stringify({
          type: "figma-event",
          event: "status-update",
          clientId: this.clientId,
          file: {
            name: "Design System App",
            currentPage: { id: "0:1", name: "Screens" },
            selectionCount,
          },
        })
      );
    }
  }

  public async close(): Promise<void> {
    if (!this.ws) return;
    const ws = this.ws;
    this.ws = null;
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      await new Promise<void>((resolve) => {
        ws.once("close", () => resolve());
        ws.close();
      });
    }
  }

  private handleMethod(method: string, params: Record<string, unknown>): unknown {
    switch (method) {
      case "get_document_info":
        return {
          fileName: "Design System App",
          currentPage: { id: "0:1", name: "Screens" },
          pages: [{ id: "0:1", name: "Screens", isCurrent: true }],
          topLevelFrames: [
            {
              id: "10:1",
              name: "HeroCard",
              type: "FRAME",
              visible: true,
              bounds: { x: 0, y: 0, width: 400, height: 240 },
            },
          ],
          selection: [
            {
              id: "10:1",
              name: "HeroCard",
              type: "FRAME",
              bounds: { x: 0, y: 0, width: 400, height: 240 },
            },
          ],
        };

      case "get_selection":
        return {
          fileName: "Design System App",
          page: { id: "0:1", name: "Screens" },
          selectionCount: 1,
          nodes: [this.fixtures.sampleCardNode],
        };

      case "get_node": {
        const nodeIds = Array.isArray(params.nodeIds) ? (params.nodeIds as string[]) : [];
        return {
          fileName: "Design System App",
          nodes: nodeIds.map((id) => ({
            ...this.fixtures.sampleCardNode,
            id,
          })),
        };
      }

      case "get_page_structure":
        return {
          fileName: "Design System App",
          page: { id: "0:1", name: "Screens" },
          childCount: 1,
          children: [
            {
              id: "10:1",
              name: "HeroCard",
              type: "FRAME",
              childCount: 2,
            },
          ],
        };

      case "search_nodes":
        return {
          fileName: "Design System App",
          scope: params.scope ?? "current_page",
          count: 1,
          results: [
            {
              id: "10:2",
              name: "Title",
              type: "TEXT",
              pageName: "Screens",
              characters: "Dashboard Overview",
            },
          ],
        };

      case "get_styles":
        return {
          fileName: "Design System App",
          paintStyles: [
            {
              id: "S:1",
              key: "paint-1",
              name: "Brand/Primary",
              paints: [{ type: "SOLID", color: { hex: "#3b82f6", r: 0.2314, g: 0.5098, b: 0.9647, a: 1 } }],
            },
          ],
          textStyles: [],
          effectStyles: [],
          gridStyles: [],
        };

      case "get_variables":
        return this.fixtures.variablesPayload;

      case "get_components":
        return {
          fileName: "Design System App",
          scope: params.scope ?? "current_page",
          count: 1,
          components: [
            {
              id: "20:1",
              key: "comp-btn",
              name: "Button",
              type: "COMPONENT_SET",
              pageName: "Screens",
              variantCount: 4,
            },
          ],
        };

      case "export_node": {
        const format = params.format === "SVG" ? "SVG" : params.format === "JPG" ? "JPG" : "PNG";
        if (format === "SVG") {
          return {
            nodeId: (params.nodeId as string | undefined) ?? "10:3",
            name: "ArrowIcon",
            format: "SVG",
            byteLength: Buffer.byteLength(SAMPLE_SVG, "utf8"),
            svg: SAMPLE_SVG,
          };
        }
        return {
          nodeId: (params.nodeId as string | undefined) ?? "10:1",
          name: "HeroCard",
          format,
          scale: params.scale ?? 2,
          byteLength: Buffer.from(SAMPLE_PNG_BASE64, "base64").byteLength,
          base64: SAMPLE_PNG_BASE64,
        };
      }

      default:
        throw new Error(`Unsupported test method: ${method}`);
    }
  }
}

async function createMcpClient(name: string) {
  const cleanEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string") cleanEnv[k] = v;
  }
  cleanEnv.FIGMA_BRIDGE_PORT = String(TEST_PORT);

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_ENTRY],
    env: cleanEnv,
    stderr: "pipe",
  });

  transport.stderr?.on("data", (chunk: Buffer) => {
    process.stderr.write(`[${name}] ${chunk.toString("utf8")}`);
  });

  const client = new Client(
    { name, version: "1.0.0" },
    { capabilities: {} }
  );

  await client.connect(transport);
  return { client, transport };
}

function getTextContent(result: { content: Array<{ type: string; text?: string }> }): string {
  const textBlock = result.content.find((c) => c.type === "text");
  assert.ok(textBlock && typeof textBlock.text === "string", "Expected text content block");
  return textBlock.text;
}

async function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const tmpPng = `/tmp/figma-bridge-test-${process.pid}.png`;
  const tmpSvg = `/tmp/figma-bridge-test-${process.pid}.svg`;

  let mcp1: Awaited<ReturnType<typeof createMcpClient>> | null = null;
  let mcp2: Awaited<ReturnType<typeof createMcpClient>> | null = null;
  const mockPlugin = new MockFigmaPlugin();

  try {
    console.log("1. Starting Leader MCP (#1) and Follower MCP (#2) on port", TEST_PORT);
    mcp1 = await createMcpClient("test-client-1");

    const status1Res = await mcp1.client.callTool({ name: "figma_get_status", arguments: {} });
    const status1 = JSON.parse(getTextContent(status1Res as never)) as {
      mode: string;
      port: number;
      connectedPlugins: unknown[];
    };
    assert.equal(status1.mode, "leader");
    assert.equal(status1.port, TEST_PORT);
    assert.equal(status1.connectedPlugins.length, 0);

    mcp2 = await createMcpClient("test-client-2");
    const status2Res = await mcp2.client.callTool({ name: "figma_get_status", arguments: {} });
    const status2 = JSON.parse(getTextContent(status2Res as never)) as {
      mode: string;
      port: number;
      connectedPlugins: unknown[];
    };
    assert.equal(status2.mode, "follower");
    assert.equal(status2.port, TEST_PORT);

    console.log("2. Verifying all 10 tools and error handling without plugin...");
    const toolsList = await mcp1.client.listTools();
    const names = toolsList.tools.map((t) => t.name);
    assert.deepEqual(names, EXPECTED_TOOLS);

    const noPluginSel = await mcp1.client.callTool({ name: "figma_get_selection", arguments: {} });
    assert.equal(noPluginSel.isError, true);
    assert.match(getTextContent(noPluginSel as never), /Figma Desktop/i);

    console.log("3. Connecting Mock Figma Plugin WS client...");
    await mockPlugin.connect(TEST_PORT);
    mockPlugin.sendStatusUpdate(2);

    const statusLeader = JSON.parse(
      getTextContent(
        (await mcp1.client.callTool({ name: "figma_get_status", arguments: {} })) as never
      )
    ) as { connectedPlugins: Array<{ file: { name: string; selectionCount: number } }> };
    assert.equal(statusLeader.connectedPlugins.length, 1);
    assert.equal(statusLeader.connectedPlugins[0]!.file.name, "Design System App");
    assert.equal(statusLeader.connectedPlugins[0]!.file.selectionCount, 2);

    const statusFollower = JSON.parse(
      getTextContent(
        (await mcp2.client.callTool({ name: "figma_get_status", arguments: {} })) as never
      )
    ) as { mode: string; connectedPlugins: unknown[] };
    assert.equal(statusFollower.mode, "follower");
    assert.equal(statusFollower.connectedPlugins.length, 1);

    console.log("4. Testing all tools across Leader and Follower...");
    const docInfo = JSON.parse(
      getTextContent(
        (await mcp2.client.callTool({ name: "figma_get_document_info", arguments: {} })) as never
      )
    ) as { fileName: string };
    assert.equal(docInfo.fileName, "Design System App");

    const sel = JSON.parse(
      getTextContent(
        (await mcp1.client.callTool({ name: "figma_get_selection", arguments: {} })) as never
      )
    ) as { nodes: Array<{ id: string; css: Record<string, string> }> };
    assert.equal(sel.nodes[0]!.id, "10:1");
    assert.equal(sel.nodes[0]!.css.display, "flex");

    const singleNode = JSON.parse(
      getTextContent(
        (await mcp2.client.callTool({
          name: "figma_get_node",
          arguments: { nodeId: "10:99" },
        })) as never
      )
    ) as { nodes: Array<{ id: string }> };
    assert.equal(singleNode.nodes[0]!.id, "10:99");

    const multiNode = JSON.parse(
      getTextContent(
        (await mcp1.client.callTool({
          name: "figma_get_node",
          arguments: { nodeIds: ["10:1", "10:2"] },
        })) as never
      )
    ) as { nodes: Array<{ id: string }> };
    assert.equal(multiNode.nodes.length, 2);

    const pageStruct = JSON.parse(
      getTextContent(
        (await mcp2.client.callTool({ name: "figma_get_page_structure", arguments: {} })) as never
      )
    ) as { childCount: number };
    assert.equal(pageStruct.childCount, 1);

    const searchRes = JSON.parse(
      getTextContent(
        (await mcp1.client.callTool({
          name: "figma_search_nodes",
          arguments: { query: "Overview", types: ["TEXT"] },
        })) as never
      )
    ) as { count: number };
    assert.equal(searchRes.count, 1);

    const stylesRes = JSON.parse(
      getTextContent(
        (await mcp2.client.callTool({ name: "figma_get_styles", arguments: {} })) as never
      )
    ) as { paintStyles: unknown[] };
    assert.equal(stylesRes.paintStyles.length, 1);

    const varsJson = JSON.parse(
      getTextContent(
        (await mcp1.client.callTool({
          name: "figma_get_variables",
          arguments: { format: "json" },
        })) as never
      )
    ) as { variables: unknown[] };
    assert.equal(varsJson.variables.length, 3);

    const varsCss = getTextContent(
      (await mcp2.client.callTool({
        name: "figma_get_variables",
        arguments: { format: "css" },
      })) as never
    );
    assert.match(varsCss, /:root \{/);
    assert.match(varsCss, /\[data-theme="dark"\] \{/);
    assert.match(varsCss, /--surface-brand: var\(--palette-blue-500\) \/\* #3b82f6 \*\/;/);
    assert.match(varsCss, /--spacing-md: 16px;/);

    const varsDtcg = JSON.parse(
      getTextContent(
        (await mcp1.client.callTool({
          name: "figma_get_variables",
          arguments: { format: "dtcg" },
        })) as never
      )
    ) as {
      Semantic: {
        Surface: { Brand: { $type: string; $value: string; $extensions: { "com.figma": { modes: Record<string, string> } } } };
      };
    };
    assert.equal(varsDtcg.Semantic.Surface.Brand.$type, "color");
    assert.equal(varsDtcg.Semantic.Surface.Brand.$value, "{Palette.Blue.500}");
    assert.equal(varsDtcg.Semantic.Surface.Brand.$extensions["com.figma"].modes.Dark, "#1d4ed8");

    const compsRes = JSON.parse(
      getTextContent(
        (await mcp2.client.callTool({ name: "figma_get_components", arguments: {} })) as never
      )
    ) as { count: number };
    assert.equal(compsRes.count, 1);

    const exportPng = await mcp1.client.callTool({
      name: "figma_export_node",
      arguments: { nodeId: "10:1", format: "PNG", scale: 2, savePath: tmpPng },
    });
    const pngContent = exportPng.content as Array<{ type: string; data?: string; mimeType?: string; text?: string }>;
    const imgBlock = pngContent.find((c) => c.type === "image");
    assert.ok(imgBlock, "Expected MCP image content block for PNG");
    assert.equal(imgBlock.mimeType, "image/png");
    assert.equal(imgBlock.data, SAMPLE_PNG_BASE64);
    assert.ok(fs.existsSync(tmpPng), "Expected PNG savePath file to exist");

    const exportSvg = await mcp2.client.callTool({
      name: "figma_export_node",
      arguments: { nodeId: "10:3", format: "SVG", savePath: tmpSvg },
    });
    const svgText = getTextContent(exportSvg as never);
    assert.match(svgText, /<svg /);
    assert.ok(fs.existsSync(tmpSvg), "Expected SVG savePath file to exist");

    console.log("5. Testing Leader -> Follower failover promotion...");
    await mcp1.transport.close();
    mcp1 = null;

    let promoted = false;
    for (let attempt = 0; attempt < 25; attempt++) {
      await delay(150);
      try {
        const res = await mcp2.client.callTool({ name: "figma_get_status", arguments: {} });
        const st = JSON.parse(getTextContent(res as never)) as { mode: string };
        if (st.mode === "leader") {
          promoted = true;
          break;
        }
      } catch {
        // Retry while follower is re-electing
      }
    }
    assert.equal(promoted, true, "Follower MCP (#2) should promote to leader after #1 exits");

    await mockPlugin.connect(TEST_PORT);
    const postFailoverDoc = JSON.parse(
      getTextContent(
        (await mcp2.client.callTool({ name: "figma_get_document_info", arguments: {} })) as never
      )
    ) as { fileName: string };
    assert.equal(postFailoverDoc.fileName, "Design System App");

    console.log("ALL TESTS PASSED!");
  } finally {
    await mockPlugin.close().catch(() => {});
    if (mcp1) await mcp1.transport.close().catch(() => {});
    if (mcp2) await mcp2.transport.close().catch(() => {});
    for (const file of [tmpPng, tmpSvg]) {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    }
  }
}

main().catch((err) => {
  console.error("TEST FAILED:", err);
  process.exit(1);
});
