// Unit-тесты HistoryStore: ring-buffer, epsilon, cleanup, copy vs reference.
// Плюс integration-тест: WS hello включает history для самолётов с накопленной траекторией.
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { HistoryStore, HISTORY_LEN, HISTORY_TTL_MS } from "../src/history";
import { TrackingServer } from "../src/server";
import { AircraftState } from "../src/state";
import type { Aircraft, ServerHello } from "../src/protocol";

const NOW = 1_700_000_000_000;

describe("HistoryStore — пустой стор", () => {
  test("новый стор: size=0, getHistory возвращает undefined", () => {
    const h = new HistoryStore();
    expect(h.size()).toBe(0);
    expect(h.getHistory("abc")).toBeUndefined();
  });
});

describe("HistoryStore — record/getHistory базовая семантика", () => {
  test("3 точки → getHistory length=3, порядок oldest→newest", () => {
    const h = new HistoryStore();
    h.record("a1", 10.0, 20.0, 1000, NOW);
    h.record("a1", 10.1, 20.1, 1100, NOW + 5_000);
    h.record("a1", 10.2, 20.2, 1200, NOW + 10_000);

    const hist = h.getHistory("a1");
    expect(hist).toBeDefined();
    expect(hist!.length).toBe(3);
    // oldest → newest
    expect(hist![0]).toEqual([10.0, 20.0, 1000, NOW]);
    expect(hist![1]).toEqual([10.1, 20.1, 1100, NOW + 5_000]);
    expect(hist![2]).toEqual([10.2, 20.2, 1200, NOW + 10_000]);
  });

  test("history между самолётами изолирована", () => {
    const h = new HistoryStore();
    h.record("a1", 10.0, 20.0, 1000, NOW);
    h.record("a2", 30.0, 40.0, 2000, NOW);

    expect(h.getHistory("a1")).toEqual([[10.0, 20.0, 1000, NOW]]);
    expect(h.getHistory("a2")).toEqual([[30.0, 40.0, 2000, NOW]]);
    expect(h.size()).toBe(2);
  });
});

describe("HistoryStore — circular buffer", () => {
  test("HISTORY_LEN+10 точек → сохраняется только последние HISTORY_LEN", () => {
    const h = new HistoryStore();
    const total = HISTORY_LEN + 10;
    for (let i = 0; i < total; i++) {
      // Каждая точка уникальна, чтобы не срабатывал epsilon-skip
      h.record("a1", 10 + i * 0.01, 20 + i * 0.01, 1000 + i, NOW + i * 1000);
    }

    const hist = h.getHistory("a1");
    expect(hist).toBeDefined();
    expect(hist!.length).toBe(HISTORY_LEN);

    // oldest должен быть с индекса 10 (первые 10 выпали)
    expect(hist![0][2]).toBe(1000 + 10);
    // newest — последний записанный
    expect(hist![hist!.length - 1][2]).toBe(1000 + total - 1);
  });
});

describe("HistoryStore — epsilon-skip для неподвижных", () => {
  test("та же позиция (epsilon-equal) записывается только один раз", () => {
    const h = new HistoryStore();
    h.record("a1", 10.0, 20.0, 1000, NOW);
    h.record("a1", 10.0, 20.0, 1000, NOW + 5_000);
    h.record("a1", 10.0 + 1e-8, 20.0 - 1e-8, 1000, NOW + 10_000);

    const hist = h.getHistory("a1");
    expect(hist!.length).toBe(1);
    expect(hist![0]).toEqual([10.0, 20.0, 1000, NOW]);
  });

  test("малое движение выше epsilon — точка добавляется", () => {
    const h = new HistoryStore();
    h.record("a1", 10.0, 20.0, 1000, NOW);
    // 1e-5 >> POS_EPSILON (1e-6)
    h.record("a1", 10.0 + 1e-5, 20.0, 1000, NOW + 5_000);

    const hist = h.getHistory("a1");
    expect(hist!.length).toBe(2);
  });

  test("epsilon-skip обновляет lastT (важно для TTL)", () => {
    const h = new HistoryStore();
    h.record("a1", 10.0, 20.0, 1000, NOW);
    // Эта запись — та же позиция, точка НЕ добавится, но lastT должен стать NOW + 100500
    h.record("a1", 10.0, 20.0, 1000, NOW + 100_500);

    // Проверим через cleanup: если lastT обновился, НЕ должно почистить.
    // now = NOW + 100_500 + HISTORY_TTL_MS - 1 → ring ещё свежий.
    const removed = h.cleanup(NOW + 100_500 + HISTORY_TTL_MS - 1);
    expect(removed).toBe(0);
    expect(h.getHistory("a1")).toBeDefined();
  });
});

describe("HistoryStore — cleanup", () => {
  test("stale ring (lastT старше TTL) удаляется", () => {
    const h = new HistoryStore();
    h.record("a1", 10.0, 20.0, 1000, NOW);
    h.record("a2", 30.0, 40.0, 2000, NOW + 10 * 60_000); // свежий

    // now = NOW + TTL + 1 сек → a1 старше TTL, a2 свежий.
    const removed = h.cleanup(NOW + HISTORY_TTL_MS + 1000);
    expect(removed).toBe(1);
    expect(h.getHistory("a1")).toBeUndefined();
    expect(h.getHistory("a2")).toBeDefined();
    expect(h.size()).toBe(1);
  });

  test("cleanup не удаляет ring чей lastT в пределах TTL", () => {
    const h = new HistoryStore();
    h.record("a1", 10.0, 20.0, 1000, NOW);
    // now = NOW + TTL - 1 сек → ring всё ещё свежий.
    const removed = h.cleanup(NOW + HISTORY_TTL_MS - 1000);
    expect(removed).toBe(0);
    expect(h.getHistory("a1")).toBeDefined();
  });

  test("cleanup на пустом сторе возвращает 0", () => {
    const h = new HistoryStore();
    expect(h.cleanup(NOW)).toBe(0);
  });

  test("несколько stale rings одновременно удаляются", () => {
    const h = new HistoryStore();
    h.record("a1", 1, 1, 0, NOW);
    h.record("a2", 2, 2, 0, NOW);
    h.record("a3", 3, 3, 0, NOW + 10 * 60_000); // свежий

    const removed = h.cleanup(NOW + HISTORY_TTL_MS + 1000);
    expect(removed).toBe(2);
    expect(h.size()).toBe(1);
    expect(h.getHistory("a3")).toBeDefined();
  });
});

describe("HistoryStore — copy vs reference", () => {
  test("модификация возвращённого массива не влияет на стор", () => {
    const h = new HistoryStore();
    h.record("a1", 10.0, 20.0, 1000, NOW);
    h.record("a1", 11.0, 21.0, 1100, NOW + 5_000);

    const hist1 = h.getHistory("a1")!;
    hist1.push([999, 999, 999, 999]);
    hist1[0][0] = -1;

    const hist2 = h.getHistory("a1")!;
    expect(hist2.length).toBe(2); // не 3 — push не повлиял
    expect(hist2[0][0]).toBe(10.0); // не -1 — mutation внутренней точки не повлиял
  });

  test("дополнительные вызовы record после getHistory видны в новом getHistory", () => {
    const h = new HistoryStore();
    h.record("a1", 10.0, 20.0, 1000, NOW);

    const hist1 = h.getHistory("a1")!;
    expect(hist1.length).toBe(1);

    h.record("a1", 11.0, 21.0, 1100, NOW + 5_000);

    const hist2 = h.getHistory("a1")!;
    expect(hist2.length).toBe(2);
    // Первая копия не поменялась (copy, not reference)
    expect(hist1.length).toBe(1);
  });
});

// ---- Integration: WS hello включает history ----

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

const PORT = Number(process.env.TEST_PORT_HISTORY ?? 18085);
const WS_URL = `ws://localhost:${PORT}/ws`;

let state: AircraftState;
let history: HistoryStore;
let server: TrackingServer;

beforeAll(() => {
  state = new AircraftState();
  history = new HistoryStore();
  server = new TrackingServer(state, PORT, history);
  server.start();
});

afterAll(() => {
  server.stop();
});

describe("WS integration — hello включает history", () => {
  test("Aircraft с накопленной историей получает history в hello, без истории — не получает", async () => {
    state.map.clear();
    // two aircraft in state
    state.applySnapshot([
      makeAircraft({ id: "h1", lon: 10, lat: 20 }),
      makeAircraft({ id: "h2", lon: 30, lat: 40 }),
    ]);

    // Для h1 — несколько точек истории (length > 1).
    const now = Date.now();
    history.record("h1", 20.0, 10.0, 1000, now - 10_000);
    history.record("h1", 20.1, 10.1, 1100, now - 5_000);
    history.record("h1", 20.2, 10.2, 1200, now);
    // Для h2 — история не записывалась.

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
    expect(msg.initial).toHaveLength(2);

    const byId = new Map(msg.initial.map((a) => [a.id, a]));
    const h1 = byId.get("h1")!;
    const h2 = byId.get("h2")!;

    expect(h1).toBeDefined();
    expect(h1.history).toBeDefined();
    expect(h1.history!.length).toBe(3);
    expect(h1.history![0]).toEqual([20.0, 10.0, 1000, now - 10_000]);
    expect(h1.history![2]).toEqual([20.2, 10.2, 1200, now]);

    expect(h2).toBeDefined();
    expect(h2.history).toBeUndefined();

    state.map.clear();
  });

  test("Aircraft с единственной точкой (length=1) НЕ получает history (порог >1)", async () => {
    state.map.clear();
    state.applySnapshot([makeAircraft({ id: "solo", lon: 50, lat: 60 })]);

    // Только одна точка — в hello history быть не должно.
    history.record("solo", 60.0, 50.0, 3000, Date.now());

    const msg = await new Promise<ServerHello>((resolve, reject) => {
      const ws = new WebSocket(WS_URL);
      const timer = setTimeout(() => reject(new Error("WS timeout")), 3000);
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

    expect(msg.initial).toHaveLength(1);
    expect(msg.initial[0].history).toBeUndefined();

    state.map.clear();
  });
});
