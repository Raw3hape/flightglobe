// Bun.serve HTTP + WebSocket сервер.
import type { ServerWebSocket } from "bun";
import type { Aircraft, ServerDelta, ServerHello, ServerMessage } from "./protocol";
import { AircraftState } from "./state";
import { HistoryStore } from "./history";

type WsData = {
  id: string;
  connectedAt: number;
};

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export class TrackingServer {
  private clients: Set<ServerWebSocket<WsData>> = new Set();
  private server: ReturnType<typeof Bun.serve> | null = null;
  private nextClientId = 1;

  constructor(
    private state: AircraftState,
    private port: number,
    private history: HistoryStore | null = null,
  ) {}

  /**
   * Формирует initial snapshot для hello: для каждого Aircraft инжектит history
   * если HistoryStore содержит значимую историю (length > 1).
   */
  private buildInitialWithHistory(): Aircraft[] {
    const base = this.state.snapshot();
    if (!this.history) return base;
    const out: Aircraft[] = [];
    for (const ac of base) {
      const h = this.history.getHistory(ac.id);
      if (h !== undefined && h.length > 1) {
        out.push({ ...ac, history: h });
      } else {
        out.push(ac);
      }
    }
    return out;
  }

  start(): void {
    const self = this;
    this.server = Bun.serve<WsData>({
      port: this.port,
      fetch(req, server) {
        const url = new URL(req.url);

        // Preflight CORS
        if (req.method === "OPTIONS") {
          return new Response(null, { status: 204, headers: CORS_HEADERS });
        }

        if (url.pathname === "/health") {
          const body = JSON.stringify({
            ok: true,
            aircraft: self.state.size(),
            clients: self.clients.size,
            history: self.history ? self.history.size() : 0,
          });
          return new Response(body, {
            headers: {
              ...CORS_HEADERS,
              "Content-Type": "application/json",
            },
          });
        }

        if (url.pathname === "/ws") {
          const id = `c${self.nextClientId++}`;
          const ok = server.upgrade(req, {
            data: { id, connectedAt: Date.now() } as WsData,
          });
          if (ok) {
            return undefined;
          }
          return new Response("WebSocket upgrade failed", {
            status: 400,
            headers: CORS_HEADERS,
          });
        }

        if (url.pathname === "/") {
          return new Response(
            JSON.stringify({
              service: "tracking-backend",
              endpoints: ["/health", "/ws"],
            }),
            {
              headers: {
                ...CORS_HEADERS,
                "Content-Type": "application/json",
              },
            },
          );
        }

        return new Response("Not Found", {
          status: 404,
          headers: CORS_HEADERS,
        });
      },
      websocket: {
        open(ws) {
          self.clients.add(ws);
          const initial = self.buildInitialWithHistory();
          const hello: ServerHello = {
            t: "hello",
            serverTime: Date.now(),
            initial,
          };
          try {
            ws.send(JSON.stringify(hello));
            const withHistory = initial.filter((a) => a.history && a.history.length > 1).length;
            console.log(
              `[ws] ${ws.data.id} connected — sent hello with ${hello.initial.length} aircraft ` +
                `(${withHistory} with history, clients=${self.clients.size})`,
            );
          } catch (err) {
            console.error(
              `[ws] ${ws.data.id} failed to send hello: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          }
        },
        message(_ws, _msg) {
          // Клиент ничего не шлёт в MVP. Игнорируем.
        },
        close(ws, code, reason) {
          self.clients.delete(ws);
          console.log(
            `[ws] ${ws.data.id} disconnected code=${code} reason=${reason || "(none)"} ` +
              `(clients=${self.clients.size})`,
          );
        },
        drain(_ws) {
          // backpressure relieved — сейчас ничего не делаем
        },
      },
      error(err) {
        console.error(`[server] error: ${err.message}`);
        return new Response("Internal Server Error", {
          status: 500,
          headers: CORS_HEADERS,
        });
      },
    });

    console.log(`[server] listening on http://localhost:${this.port}`);
    console.log(`[server]   GET /health`);
    console.log(`[server]   WS  /ws`);
  }

  stop(): void {
    if (this.server) {
      this.server.stop(true);
      this.server = null;
    }
    for (const ws of this.clients) {
      try {
        ws.close(1001, "server shutting down");
      } catch {}
    }
    this.clients.clear();
  }

  /**
   * Рассылает дельту всем подключённым клиентам. Пустые дельты пропускаем
   * чтобы не спамить сеть. В delta история НЕ включается — только в hello.
   */
  broadcastDelta(delta: ServerDelta): void {
    if (
      delta.spawned.length === 0 &&
      delta.updated.length === 0 &&
      delta.despawned.length === 0
    ) {
      return;
    }
    if (this.clients.size === 0) return;
    const payload: ServerMessage = delta;
    const serialized = JSON.stringify(payload);
    let sent = 0;
    let failed = 0;
    for (const ws of this.clients) {
      try {
        // Bun's send возвращает количество байт или -1 при backpressure,
        // нам достаточно отправить — клиент сам обработает.
        ws.send(serialized);
        sent++;
      } catch (err) {
        failed++;
        console.error(
          `[ws] ${ws.data.id} send failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    if (sent > 0 || failed > 0) {
      console.log(
        `[ws] broadcast delta: sent=${sent} failed=${failed} ` +
          `(spawned=${delta.spawned.length} updated=${delta.updated.length} despawned=${delta.despawned.length})`,
      );
    }
  }
}
