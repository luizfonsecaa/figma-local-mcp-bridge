/**
 * Shared WebSocket wire protocol between the MCP server bridge
 * (leader/follower processes) and the Figma Desktop plugin UI.
 */

export interface FigmaFileSummary {
  name: string;
  currentPage: {
    id: string;
    name: string;
  };
  selectionCount: number;
}

export interface ConnectedPluginInfo {
  clientId: string;
  file: FigmaFileSummary;
  connectedAt: string;
  lastActiveAt: string;
}

export type HelloMessage =
  | {
      type: "hello";
      role: "figma-plugin";
      clientId: string;
      file: FigmaFileSummary;
    }
  | {
      type: "hello";
      role: "mcp-client";
      clientId: string;
    };

export interface HelloAckMessage {
  type: "hello-ack";
  ok: true;
  port: number;
}

export interface FigmaEventMessage {
  type: "figma-event";
  event: "status-update";
  clientId: string;
  file: FigmaFileSummary;
}

export interface BridgeRequestMessage {
  type: "request";
  id: string;
  method: string;
  params?: Record<string, unknown>;
  targetFile?: string;
}

export type BridgeResponseMessage =
  | {
      type: "response";
      id: string;
      ok: true;
      result: unknown;
    }
  | {
      type: "response";
      id: string;
      ok: false;
      error: string;
    };

export interface BridgeStatusResult {
  mode: "leader" | "follower" | "starting";
  port: number;
  connectedPlugins: ConnectedPluginInfo[];
}

export const BRIDGE_STATUS_METHOD = "__bridge_status__";

export type IncomingWsMessage =
  | HelloMessage
  | FigmaEventMessage
  | BridgeRequestMessage
  | BridgeResponseMessage
  | HelloAckMessage;
