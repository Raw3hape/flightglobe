// Integration-тесты: запускаем реальный TrackingServer на свободном порту и общаемся по HTTP/WS.
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { TrackingServer } from "../src/server";
import { AircraftState } from "../src/state";
import type { Aircraft, ServerHello, ServerDelta } from "../src/protocol";

const PORT = Number(process.env.TEST_PORT ?? 18080);
const BASE_URL = `http://localhost:${PORT}`;
const WS_URL = `ws://localhost:${PORT}/ws`;

function makeAircraft(overrides: Partial<Aircraft> = {}): Aircraft {
  return {
    id: "abc123",
    callsign: "TEST01",
    country: null,
    lon: 10,
    lat: 20,
    altitude: 1000,
    velocity: 100,
    heading: 90,
    vertRate: 0,
    onGround: false,
    updatedAt: Date.now(),
    ...overrides,
  };
}

let state: AircraftState;
let server: TrackingServer;

beforeAll(() => {
  state = new AircraftState();
  server = new TrackingServer(state, PORT);
  server.start();
});

afterAll(() => {
  // Graceful shutdown
  server.stop();
});

describe("HTTP — /health", () => {
  test("GET /health → 200 с JSON { ok, aircraft, clients } и CORS=*", async () => {
    const res = await fetch(`${BASE_URL}/health`);
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("content-type")).toContain("application/json");

    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(typeof body.aircraft).toBe("number");
    expect(typeof body.clients).toBe("number");
  });

  test("aircraft в /health отражает реальное количество в state", async () => {
    state.applySnapshot([
      makeAircraft({ id: "aa1" }),
      makeAircraft({ id: "aa2" }),
      makeAircraft({ id: "aa3" }),
    ]);
    const res = await fetch(`${BASE_URL}/health`);
    const body = await res.json();
    expect(body.aircraft).toBe(3);

    // Очистим, чтобы не мешало последующим тестам
    state.map.clear();
  });
});

describe("HTTP — CORS preflight", () => {
  test("OPTIONS → 204 с правильными CORS-заголовками", async () => {
    const res = await fetch(`${BASE_URL}/health`, { method: "OPTIONS" });
    expect([200, 204]).toContain(res.status);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-methods")).toContain("GET");
    expect(res.headers.get("access-control-allow-methods")).toContain("OPTIONS");
    expect(res.headers.get("access-control-allow-headers")).toContain("Content-Type");
  });
});

describe("HTTP — прочие роуты", () => {
  test("GET / → 200 с описанием сервиса", async () => {
    const res = await fetch(`${BASE_URL}/`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.service).toBe("tracking-backend");
    expect(Array.isArray(body.endpoints)).toBe(true);
  });

  test("GET /nope → 404", async () => {
    const res = await fetch(`${BASE_URL}/nope`);
    expect(res.status).toBe(404);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });
});

describe("WebSocket — подключение и hello", () => {
  test("подключение → первое сообщение type=hello с initial array", async () => {
    // Подготовим состояние
    state.map.clear();
    state.applySnapshot([
      makeAircraft({ id: "ws1", lon: 1, lat: 1 }),
      makeAircraft({ id: "ws2", lon: 2, lat: 2 }),
    ]);

    const msg = await new Promise<ServerHello>((resolve, reject) => {
      const ws = new WebSocket(WS_URL);
      const timer = setTimeout(() => {
        try {
          ws.close();
        } catch {}
        reject(new Error("WS timeout waiting for hello"));
      }, 3000);

      ws.addEventListener("message", (ev) => {
        clearTimeout(timer);
        try {
          const parsed = JSON.parse(ev.data as string);
          ws.close();
          resolve(parsed as ServerHello);
        } catch (err) {
          ws.close();
          reject(err);
        }
      });
      ws.addEventListener("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    expect(msg.t).toBe("hello");
    expect(typeof msg.serverTime).toBe("number");
    expect(Array.isArray(msg.initial)).toBe(true);
    expect(msg.initial).toHaveLength(2);
    const ids = msg.initial.map((a) => a.id).sort();
    expect(ids).toEqual(["ws1", "ws2"]);

    state.map.clear();
  });

  test("пустой state → hello.initial = []", async () => {
    state.map.clear();

    const msg = await new Promise<ServerHello>((resolve, reject) => {
      const ws = new WebSocket(WS_URL);
      const timer = setTimeout(() => {
        try {
          ws.close();
        } catch {}
        reject(new Error("WS timeout"));
      }, 3000);

      ws.addEventListener("message", (ev) => {
        clearTimeout(timer);
        try {
          const parsed = JSON.parse(ev.data as string);
          ws.close();
          resolve(parsed as ServerHello);
        } catch (err) {
          ws.close();
          reject(err);
        }
      });
      ws.addEventListener("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    expect(msg.t).toBe("hello");
    expect(msg.initial).toEqual([]);
  });
});

describe("WebSocket — broadcastDelta", () => {
  test("подключённый клиент получает delta от broadcast", async () => {
    state.map.clear();

    const received: (ServerHello | ServerDelta)[] = [];
    const deltaPromise = new Promise<ServerDelta>((resolve, reject) => {
      const ws = new WebSocket(WS_URL);
      const timer = setTimeout(() => {
        try {
          ws.close();
        } catch {}
        reject(new Error("WS timeout waiting for delta"));
      }, 3000);

      ws.addEventListener("message", (ev) => {
        try {
          const parsed = JSON.parse(ev.data as string);
          received.push(parsed);
          if (parsed.t === "hello") {
            // Получили hello — триггерим broadcast
            const delta: ServerDelta = {
              t: "delta",
              serverTime: Date.now(),
              spawned: [makeAircraft({ id: "brd1" })],
              updated: [],
              despawned: [],
            };
            // Дадим чуть времени клиенту подписаться
            setTimeout(() => server.broadcastDelta(delta), 50);
          } else if (parsed.t === "delta") {
            clearTimeout(timer);
            ws.close();
            resolve(parsed as ServerDelta);
          }
        } catch (err) {
          clearTimeout(timer);
          ws.close();
          reject(err);
        }
      });
      ws.addEventListener("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    const delta = await deltaPromise;
    expect(delta.t).toBe("delta");
    expect(delta.spawned).toHaveLength(1);
    expect(delta.spawned[0].id).toBe("brd1");
  });

  test("пустой delta НЕ броадкастится (оптимизация)", async () => {
    state.map.clear();

    // Подключаемся, ждём hello, потом шлём пустой delta — не должны его получить.
    const result = await new Promise<{ deltaReceived: boolean }>((resolve, reject) => {
      const ws = new WebSocket(WS_URL);
      let sawHello = false;
      const timer = setTimeout(() => {
        try {
          ws.close();
        } catch {}
        // Если за 300мс delta не пришло — всё ок, пустой delta не броадкастится
        resolve({ deltaReceived: false });
      }, 400);

      ws.addEventListener("message", (ev) => {
        try {
          const parsed = JSON.parse(ev.data as string);
          if (parsed.t === "hello") {
            sawHello = true;
            // Шлём ПУСТОЙ delta
            const emptyDelta: ServerDelta = {
              t: "delta",
              serverTime: Date.now(),
              spawned: [],
              updated: [],
              despawned: [],
            };
            setTimeout(() => server.broadcastDelta(emptyDelta), 50);
          } else if (parsed.t === "delta" && sawHello) {
            clearTimeout(timer);
            ws.close();
            resolve({ deltaReceived: true });
          }
        } catch (err) {
          clearTimeout(timer);
          ws.close();
          reject(err);
        }
      });
      ws.addEventListener("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    expect(result.deltaReceived).toBe(false);
  });
});

describe("HTTP — clients count отражается в /health", () => {
  test("после подключения WS /health.clients >= 1", async () => {
    const ws = new WebSocket(WS_URL);
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("WS open timeout")), 2000);
      ws.addEventListener("open", () => {
        clearTimeout(t);
        resolve();
      });
      ws.addEventListener("error", (err) => {
        clearTimeout(t);
        reject(err);
      });
    });

    // Маленькая пауза — open на стороне клиента может опередить учёт на сервере
    await new Promise((r) => setTimeout(r, 50));

    const res = await fetch(`${BASE_URL}/health`);
    const body = await res.json();
    expect(body.clients).toBeGreaterThanOrEqual(1);

    ws.close();
    // Дадим серверу обработать close
    await new Promise((r) => setTimeout(r, 100));
  });
});
