import { randomUUID } from "node:crypto";
import * as http from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import {
  BRIDGE_STATUS_METHOD,
  type BridgeRequestMessage,
  type BridgeResponseMessage,
  type BridgeStatusResult,
  type ConnectedPluginInfo,
  type IncomingWsMessage,
} from "./protocol.js";

const MAX_PAYLOAD_BYTES = 50 * 1024 * 1024;
const HEARTBEAT_INTERVAL_MS = 15_000;
const DEFAULT_TIMEOUT_MS = 30_000;

interface PluginEntry {
  ws: WebSocket;
  info: ConnectedPluginInfo;
}

interface SocketMeta {
  role?: "figma-plugin" | "mcp-client";
  clientId?: string;
  isAlive: boolean;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
  targetClientId?: string;
}

interface ForwardedRequest {
  requesterWs: WebSocket;
  timer: NodeJS.Timeout;
  targetClientId: string;
}

export class FigmaBridge {
  public readonly port: number;
  private readonly clientId = `mcp-${randomUUID().slice(0, 8)}`;

  private mode: "leader" | "follower" | "starting" = "starting";
  private closing = false;

  private wss: WebSocketServer | null = null;
  private httpServers: http.Server[] = [];
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private followerWs: WebSocket | null = null;
  private reElectTimer: NodeJS.Timeout | null = null;
  private readyPromise: Promise<void> | null = null;

  private readonly plugins = new Map<string, PluginEntry>();
  private readonly mcpClients = new Map<string, WebSocket>();
  private readonly socketMeta = new WeakMap<WebSocket, SocketMeta>();

  private readonly pendingFromLeader = new Map<string, PendingRequest>();
  private readonly pendingFromFollower = new Map<string, PendingRequest>();
  private readonly forwardedRequests = new Map<string, ForwardedRequest>();

  constructor(port = Number(process.env.FIGMA_BRIDGE_PORT || 3055)) {
    this.port = Number.isFinite(port) && port > 0 ? port : 3055;
  }

  public async start(): Promise<void> {
    if (this.closing) return;
    if (this.readyPromise) return this.readyPromise;

    this.readyPromise = this.runElection().finally(() => {
      this.readyPromise = null;
    });
    return this.readyPromise;
  }

  public async getStatus(): Promise<BridgeStatusResult> {
    await this.ensureReady();

    if (this.mode === "leader") {
      return this.buildStatus("leader");
    }

    const leaderStatus = await this.sendFollowerRequest<BridgeStatusResult>(
      BRIDGE_STATUS_METHOD,
      undefined,
      undefined,
      5_000
    );
    return {
      ...leaderStatus,
      mode: "follower",
    };
  }

  public async request<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    options?: { targetFile?: string; timeoutMs?: number }
  ): Promise<T> {
    await this.ensureReady();

    const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const targetFile = options?.targetFile;

    if (this.mode === "leader") {
      return (await this.sendLeaderRequest(method, params, targetFile, timeoutMs)) as T;
    }

    if (this.mode === "follower") {
      return (await this.sendFollowerRequest(method, params, targetFile, timeoutMs)) as T;
    }

    throw new Error("Bridge is currently re-electing; retry in a moment.");
  }

  public async close(): Promise<void> {
    this.closing = true;

    if (this.reElectTimer) {
      clearTimeout(this.reElectTimer);
      this.reElectTimer = null;
    }

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    this.rejectAllPending(this.pendingFromLeader, "Bridge is closing.");
    this.rejectAllPending(this.pendingFromFollower, "Bridge is closing.");

    for (const [id, forwarded] of this.forwardedRequests.entries()) {
      clearTimeout(forwarded.timer);
      this.forwardedRequests.delete(id);
    }

    if (this.followerWs) {
      const ws = this.followerWs;
      this.followerWs = null;
      try {
        ws.close();
      } catch {
        // Ignore close errors during shutdown
      }
    }

    if (this.wss) {
      const server = this.wss;
      this.wss = null;
      for (const client of server.clients) {
        try {
          client.close();
        } catch {
          // Ignore client close errors during shutdown
        }
      }
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }

    if (this.httpServers.length > 0) {
      const servers = this.httpServers;
      this.httpServers = [];
      await Promise.all(
        servers.map(
          (srv) =>
            new Promise<void>((resolve) => {
              try {
                srv.closeAllConnections?.();
              } catch {
                // Ignore closeAllConnections errors
              }
              srv.close(() => resolve());
            })
        )
      );
    }

    this.plugins.clear();
    this.mcpClients.clear();
  }

  private async ensureReady(): Promise<void> {
    if (this.closing) {
      throw new Error("FigmaBridge has been closed.");
    }
    if (this.mode === "leader" || (this.mode === "follower" && this.followerWs?.readyState === WebSocket.OPEN)) {
      return;
    }
    if (this.readyPromise) {
      await this.readyPromise;
      return;
    }
    if (this.reElectTimer) {
      await new Promise<void>((resolve) => {
        const check = setInterval(() => {
          if (this.closing || this.mode !== "starting") {
            clearInterval(check);
            resolve();
          }
        }, 50);
      });
      return;
    }
    await this.start();
  }

  private async runElection(): Promise<void> {
    if (this.closing) return;
    this.mode = "starting";

    const bound = await this.tryBecomeLeader();
    if (bound || this.closing) {
      return;
    }

    try {
      await this.connectAsFollower();
    } catch (err) {
      if (this.closing) return;
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (code === "EPERM" || code === "EACCES") {
        throw err;
      }
      console.error(
        `[figma-bridge] Follower connect failed (${err instanceof Error ? err.message : String(err)}), retrying election...`
      );
      await this.delay(300 + Math.floor(Math.random() * 200));
      await this.runElection();
    }
  }

  private tryBecomeLeader(): Promise<boolean> {
    return new Promise((resolve, reject) => {
      const primaryServer = http.createServer((_req, res) => {
        res.writeHead(426, { "Content-Type": "text/plain" });
        res.end("Upgrade Required");
      });

      const onStartupError = (err: Error): void => {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "EADDRINUSE") {
          try {
            primaryServer.close();
          } catch {
            // Ignore close errors
          }
          resolve(false);
          return;
        }
        try {
          primaryServer.close();
        } catch {
          // Ignore close errors
        }
        reject(err);
      };

      primaryServer.once("error", onStartupError);

      primaryServer.once("listening", () => {
        primaryServer.off("error", onStartupError);

        const wss = new WebSocketServer({
          noServer: true,
          maxPayload: MAX_PAYLOAD_BYTES,
        });

        wss.on("error", (err) => {
          console.error(`[figma-bridge] WebSocketServer error: ${err.message}`);
        });

        wss.on("connection", (ws) => this.handleLeaderConnection(ws));

        const attachUpgrade = (srv: http.Server): void => {
          srv.on("error", (err) => {
            console.error(`[figma-bridge] HTTP loop server error: ${err.message}`);
          });
          srv.on("upgrade", (req, socket, head) => {
            wss.handleUpgrade(req, socket, head, (ws) => {
              wss.emit("connection", ws, req);
            });
          });
        };

        attachUpgrade(primaryServer);
        this.httpServers.push(primaryServer);

        // Also bind IPv6 loopback (::1) best-effort because macOS often resolves 'localhost' to ::1
        const ipv6Server = http.createServer((_req, res) => {
          res.writeHead(426, { "Content-Type": "text/plain" });
          res.end("Upgrade Required");
        });
        ipv6Server.once("error", () => {
          try {
            ipv6Server.close();
          } catch {
            // Ignore when IPv6 loopback is unavailable or already bound
          }
        });
        ipv6Server.once("listening", () => {
          if (this.closing) {
            try {
              ipv6Server.close();
            } catch {
              // Ignore close errors
            }
            return;
          }
          attachUpgrade(ipv6Server);
          this.httpServers.push(ipv6Server);
        });
        ipv6Server.listen(this.port, "::1");

        this.wss = wss;
        this.mode = "leader";
        this.startHeartbeat();

        console.error(`[figma-bridge] Listening on ws://localhost:${this.port} (leader)`);
        resolve(true);
      });

      primaryServer.listen(this.port, "127.0.0.1");
    });
  }

  private connectAsFollower(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.closing) {
        resolve();
        return;
      }

      const ws = new WebSocket(`ws://127.0.0.1:${this.port}`, {
        maxPayload: MAX_PAYLOAD_BYTES,
      });

      let settled = false;
      let handshakeCompleted = false;

      const cleanupStartup = (): void => {
        ws.off("error", onStartupError);
      };

      const onStartupError = (err: Error): void => {
        if (!settled) {
          settled = true;
          cleanupStartup();
          reject(err);
        }
      };

      ws.once("error", onStartupError);

      ws.once("open", () => {
        this.sendJson(ws, {
          type: "hello",
          role: "mcp-client",
          clientId: this.clientId,
        });
      });

      ws.on("message", (raw) => {
        const msg = this.parseMessage(raw.toString("utf8"));
        if (!msg) return;

        if (msg.type === "hello-ack") {
          if (!settled) {
            settled = true;
            handshakeCompleted = true;
            cleanupStartup();
            this.followerWs = ws;
            this.mode = "follower";
            console.error(`[figma-bridge] Connected to leader on ws://127.0.0.1:${this.port} (follower)`);
            resolve();
          }
          return;
        }

        if (msg.type === "response") {
          this.handlePendingResponse(this.pendingFromFollower, msg);
        }
      });

      ws.on("close", () => {
        if (!settled) {
          settled = true;
          cleanupStartup();
          reject(new Error("WebSocket closed before handshake completed."));
          return;
        }
        if (!handshakeCompleted) {
          return;
        }

        if (this.followerWs === ws) {
          this.followerWs = null;
        }
        this.rejectAllPending(
          this.pendingFromFollower,
          "Bridge leader disconnected; re-electing leader."
        );

        if (!this.closing) {
          this.mode = "starting";
          this.scheduleReElection();
        }
      });

      ws.on("error", (err) => {
        if (handshakeCompleted) {
          console.error(`[figma-bridge] Follower socket error: ${err.message}`);
        }
      });
    });
  }

  private scheduleReElection(): void {
    if (this.closing || this.reElectTimer) return;

    const jitterMs = 300 + Math.floor(Math.random() * 200);
    this.reElectTimer = setTimeout(() => {
      this.reElectTimer = null;
      if (this.closing) return;
      this.readyPromise = this.runElection()
        .catch((err) => {
          console.error(
            `[figma-bridge] Re-election failed: ${err instanceof Error ? err.message : String(err)}`
          );
          if (!this.closing) {
            this.scheduleReElection();
          }
        })
        .finally(() => {
          this.readyPromise = null;
        });
    }, jitterMs);
  }

  private handleLeaderConnection(ws: WebSocket): void {
    this.socketMeta.set(ws, { isAlive: true });

    ws.on("pong", () => {
      const meta = this.socketMeta.get(ws);
      if (meta) {
        meta.isAlive = true;
      }
    });

    ws.on("message", (raw) => {
      const msg = this.parseMessage(raw.toString("utf8"));
      if (!msg) return;

      if (msg.type === "hello") {
        this.handleHello(ws, msg);
        return;
      }

      if (msg.type === "figma-event" && msg.event === "status-update") {
        const entry = this.plugins.get(msg.clientId);
        if (entry && entry.ws === ws) {
          entry.info.file = msg.file;
          entry.info.lastActiveAt = new Date().toISOString();
        }
        return;
      }

      if (msg.type === "request") {
        this.handleFollowerForwardedRequest(ws, msg);
        return;
      }

      if (msg.type === "response") {
        if (this.pendingFromLeader.has(msg.id)) {
          this.handlePendingResponse(this.pendingFromLeader, msg);
          return;
        }
        const forwarded = this.forwardedRequests.get(msg.id);
        if (forwarded) {
          clearTimeout(forwarded.timer);
          this.forwardedRequests.delete(msg.id);
          if (forwarded.requesterWs.readyState === WebSocket.OPEN) {
            this.sendJson(forwarded.requesterWs, msg);
          }
        }
      }
    });

    ws.on("close", () => {
      const meta = this.socketMeta.get(ws);
      if (!meta?.clientId) return;

      if (meta.role === "figma-plugin") {
        const existing = this.plugins.get(meta.clientId);
        if (existing?.ws === ws) {
          this.plugins.delete(meta.clientId);
          console.error(`[figma-bridge] Figma plugin disconnected: ${meta.clientId}`);
        }

        for (const [id, pending] of this.pendingFromLeader.entries()) {
          if (pending.targetClientId === meta.clientId) {
            clearTimeout(pending.timer);
            this.pendingFromLeader.delete(id);
            pending.reject(new Error(`Figma plugin '${meta.clientId}' disconnected during request.`));
          }
        }

        for (const [id, forwarded] of this.forwardedRequests.entries()) {
          if (forwarded.targetClientId === meta.clientId) {
            clearTimeout(forwarded.timer);
            this.forwardedRequests.delete(id);
            if (forwarded.requesterWs.readyState === WebSocket.OPEN) {
              this.sendJson(forwarded.requesterWs, {
                type: "response",
                id,
                ok: false,
                error: `Figma plugin '${meta.clientId}' disconnected during request.`,
              });
            }
          }
        }
      } else if (meta.role === "mcp-client") {
        if (this.mcpClients.get(meta.clientId) === ws) {
          this.mcpClients.delete(meta.clientId);
        }
        for (const [id, forwarded] of this.forwardedRequests.entries()) {
          if (forwarded.requesterWs === ws) {
            clearTimeout(forwarded.timer);
            this.forwardedRequests.delete(id);
          }
        }
      }
    });

    ws.on("error", (err) => {
      console.error(`[figma-bridge] Client socket error: ${err.message}`);
    });
  }

  private handleHello(ws: WebSocket, msg: Extract<IncomingWsMessage, { type: "hello" }>): void {
    const meta = this.socketMeta.get(ws) ?? { isAlive: true };
    meta.role = msg.role;
    meta.clientId = msg.clientId;
    this.socketMeta.set(ws, meta);

    if (msg.role === "figma-plugin") {
      const prev = this.plugins.get(msg.clientId);
      if (prev && prev.ws !== ws) {
        try {
          prev.ws.terminate();
        } catch {
          // Ignore old socket terminate failure
        }
      }
      const now = new Date().toISOString();
      this.plugins.set(msg.clientId, {
        ws,
        info: {
          clientId: msg.clientId,
          file: msg.file,
          connectedAt: prev?.info.connectedAt ?? now,
          lastActiveAt: now,
        },
      });
      console.error(
        `[figma-bridge] Figma plugin connected: ${msg.clientId} (file: "${msg.file.name}")`
      );
    } else {
      this.mcpClients.set(msg.clientId, ws);
    }

    this.sendJson(ws, {
      type: "hello-ack",
      ok: true,
      port: this.port,
    });
  }

  private handleFollowerForwardedRequest(ws: WebSocket, msg: BridgeRequestMessage): void {
    if (msg.method === BRIDGE_STATUS_METHOD) {
      this.sendJson(ws, {
        type: "response",
        id: msg.id,
        ok: true,
        result: this.buildStatus("leader"),
      });
      return;
    }

    const selection = this.selectPlugin(msg.targetFile);
    if ("error" in selection) {
      this.sendJson(ws, {
        type: "response",
        id: msg.id,
        ok: false,
        error: selection.error,
      });
      return;
    }

    const timer = setTimeout(() => {
      this.forwardedRequests.delete(msg.id);
      if (ws.readyState === WebSocket.OPEN) {
        this.sendJson(ws, {
          type: "response",
          id: msg.id,
          ok: false,
          error: `Timed out waiting for Figma plugin response to '${msg.method}'.`,
        });
      }
    }, DEFAULT_TIMEOUT_MS);

    this.forwardedRequests.set(msg.id, {
      requesterWs: ws,
      timer,
      targetClientId: selection.plugin.info.clientId,
    });

    this.sendJson(selection.plugin.ws, {
      type: "request",
      id: msg.id,
      method: msg.method,
      params: msg.params,
    });
  }

  private sendLeaderRequest(
    method: string,
    params: Record<string, unknown> | undefined,
    targetFile: string | undefined,
    timeoutMs: number
  ): Promise<unknown> {
    const selection = this.selectPlugin(targetFile);
    if ("error" in selection) {
      return Promise.reject(new Error(selection.error));
    }

    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingFromLeader.delete(id);
        reject(new Error(`Timed out after ${timeoutMs}ms waiting for Figma plugin method '${method}'.`));
      }, timeoutMs);

      this.pendingFromLeader.set(id, {
        resolve,
        reject,
        timer,
        targetClientId: selection.plugin.info.clientId,
      });

      this.sendJson(selection.plugin.ws, {
        type: "request",
        id,
        method,
        params,
      });
    });
  }

  private sendFollowerRequest<T>(
    method: string,
    params: Record<string, unknown> | undefined,
    targetFile: string | undefined,
    timeoutMs: number
  ): Promise<T> {
    const ws = this.followerWs;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("Follower is not connected to bridge leader."));
    }

    const id = randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingFromFollower.delete(id);
        reject(new Error(`Timed out after ${timeoutMs}ms waiting for leader response to '${method}'.`));
      }, timeoutMs);

      this.pendingFromFollower.set(id, {
        resolve: (val) => resolve(val as T),
        reject,
        timer,
      });

      this.sendJson(ws, {
        type: "request",
        id,
        method,
        params,
        targetFile,
      });
    });
  }

  private selectPlugin(
    targetFile?: string
  ): { plugin: PluginEntry } | { error: string } {
    const openPlugins = Array.from(this.plugins.values()).filter(
      (entry) => entry.ws.readyState === WebSocket.OPEN
    );

    if (openPlugins.length === 0) {
      return {
        error: `Nenhum plugin do Figma Desktop conectado na porta ${this.port}. Abra o arquivo no Figma Desktop e execute Plugins > Development > Figma Local MCP Bridge.`,
      };
    }

    const sortedByActivity = [...openPlugins].sort((a, b) =>
      b.info.lastActiveAt.localeCompare(a.info.lastActiveAt)
    );

    if (!targetFile || targetFile.trim() === "") {
      return { plugin: sortedByActivity[0]! };
    }

    const query = targetFile.trim();
    const exactId = sortedByActivity.find((p) => p.info.clientId === query);
    if (exactId) {
      return { plugin: exactId };
    }

    const lower = query.toLowerCase();
    const matches = sortedByActivity.filter((p) =>
      p.info.file.name.toLowerCase().includes(lower)
    );
    if (matches.length > 0) {
      return { plugin: matches[0]! };
    }

    const available = sortedByActivity
      .map((p) => `"${p.info.file.name}" (${p.info.clientId})`)
      .join(", ");
    return {
      error: `Nenhum arquivo Figma conectado corresponde a '${targetFile}'. Arquivos abertos: ${available}`,
    };
  }

  private buildStatus(mode: "leader" | "follower" | "starting"): BridgeStatusResult {
    const connectedPlugins = Array.from(this.plugins.values())
      .filter((entry) => entry.ws.readyState === WebSocket.OPEN)
      .map((entry) => entry.info)
      .sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt));

    return {
      mode,
      port: this.port,
      connectedPlugins,
    };
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
    }

    this.heartbeatTimer = setInterval(() => {
      if (!this.wss) return;
      for (const ws of this.wss.clients) {
        const meta = this.socketMeta.get(ws);
        if (!meta) continue;
        if (!meta.isAlive) {
          ws.terminate();
          continue;
        }
        meta.isAlive = false;
        try {
          ws.ping();
        } catch {
          ws.terminate();
        }
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  private handlePendingResponse(
    map: Map<string, PendingRequest>,
    msg: BridgeResponseMessage
  ): void {
    const pending = map.get(msg.id);
    if (!pending) return;

    clearTimeout(pending.timer);
    map.delete(msg.id);

    if (msg.ok) {
      pending.resolve(msg.result);
    } else {
      pending.reject(new Error(msg.error || "Unknown Figma plugin error"));
    }
  }

  private rejectAllPending(map: Map<string, PendingRequest>, reason: string): void {
    for (const [id, pending] of map.entries()) {
      clearTimeout(pending.timer);
      map.delete(id);
      pending.reject(new Error(reason));
    }
  }

  private parseMessage(raw: string): IncomingWsMessage | null {
    try {
      return JSON.parse(raw) as IncomingWsMessage;
    } catch {
      return null;
    }
  }

  private sendJson(ws: WebSocket, payload: unknown): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload));
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
