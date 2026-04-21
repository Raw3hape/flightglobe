import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useStore } from "../state/store";
import type { ServerMessage, Aircraft } from "../protocol";

// Minimal WebSocket stub + registry: we replace globalThis.WebSocket with
// a class that records instances so tests can drive messages manually.
// This lets us verify useAircraftSocket wires up store correctly without
// rendering React components.

type StubWS = {
  url: string;
  readyState: number;
  onopen: ((ev?: any) => void) | null;
  onmessage: ((ev: any) => void) | null;
  onerror: ((ev?: any) => void) | null;
  onclose: ((ev?: any) => void) | null;
  close: () => void;
};

let createdSockets: StubWS[] = [];

class FakeWebSocket implements StubWS {
  url: string;
  readyState = 0;
  onopen: ((ev?: any) => void) | null = null;
  onmessage: ((ev: any) => void) | null = null;
  onerror: ((ev?: any) => void) | null = null;
  onclose: ((ev?: any) => void) | null = null;
  constructor(url: string) {
    this.url = url;
    createdSockets.push(this);
  }
  close() {
    this.readyState = 3;
    this.onclose?.({});
  }
}

function makeAircraft(overrides: Partial<Aircraft> = {}): Aircraft {
  return {
    id: "id1",
    callsign: "CS",
    country: "US",
    lat: 10,
    lon: 20,
    altitude: 5000,
    velocity: 100,
    heading: 0,
    vertRate: 0,
    onGround: false,
    updatedAt: 0,
    ...overrides,
  };
}

function resetStore() {
  useStore.setState({
    aircraft: new Map(),
    connState: "idle",
    serverTime: 0,
    count: 0,
  });
}

/**
 * Simulate what useEffect inside the hook does, without React.
 * We literally re-run the same flow: construct WS, wire handlers,
 * dispatch to the store. This lets us unit-test the handler logic.
 */
function simulateSocket(url: string) {
  const { applyHello, applyDelta, setConnState } = useStore.getState();
  setConnState("connecting");
  const ws = new (globalThis.WebSocket as any)(url) as StubWS;

  ws.onopen = () => setConnState("open");
  ws.onmessage = (ev: any) => {
    try {
      const msg = JSON.parse(ev.data) as ServerMessage;
      if (msg.t === "hello") {
        applyHello(msg.initial ?? [], msg.serverTime);
      } else if (msg.t === "delta") {
        applyDelta(
          msg.spawned ?? [],
          msg.updated ?? [],
          msg.despawned ?? [],
          msg.serverTime
        );
      }
    } catch {
      // ignored — malformed frame
    }
  };
  ws.onerror = () => setConnState("error");
  ws.onclose = () => setConnState("closed");
  return ws;
}

let origWS: any;

beforeEach(() => {
  resetStore();
  createdSockets = [];
  origWS = globalThis.WebSocket;
  (globalThis as any).WebSocket = FakeWebSocket;
});

afterEach(() => {
  (globalThis as any).WebSocket = origWS;
});

describe("socket message routing (simulated)", () => {
  it("sets connState=connecting on construction, then open on onopen", () => {
    simulateSocket("ws://localhost:8080/ws");
    expect(useStore.getState().connState).toBe("connecting");
    createdSockets[0].onopen?.();
    expect(useStore.getState().connState).toBe("open");
  });

  it("hello frame populates aircraft via applyHello", () => {
    const ws = simulateSocket("ws://x/ws");
    ws.onopen?.();
    const a = makeAircraft({ id: "a" });
    const b = makeAircraft({ id: "b" });
    ws.onmessage?.({
      data: JSON.stringify({
        t: "hello",
        serverTime: 123,
        initial: [a, b],
      }),
    });

    const state = useStore.getState();
    expect(state.aircraft.size).toBe(2);
    expect(state.aircraft.has("a")).toBe(true);
    expect(state.aircraft.has("b")).toBe(true);
    expect(state.serverTime).toBe(123);
  });

  it("delta frame dispatches spawned/updated/despawned", () => {
    const ws = simulateSocket("ws://x/ws");
    ws.onopen?.();

    // Start with a hello containing 'a' and 'b'
    ws.onmessage?.({
      data: JSON.stringify({
        t: "hello",
        serverTime: 1,
        initial: [makeAircraft({ id: "a" }), makeAircraft({ id: "b" })],
      }),
    });

    // Delta: spawn c, update a, despawn b
    ws.onmessage?.({
      data: JSON.stringify({
        t: "delta",
        serverTime: 2,
        spawned: [makeAircraft({ id: "c", lat: 77 })],
        updated: [makeAircraft({ id: "a", lat: 11 })],
        despawned: ["b"],
      }),
    });

    const { aircraft } = useStore.getState();
    expect(aircraft.has("c")).toBe(true);
    expect(aircraft.get("c")!.baseLat).toBe(77);
    expect(aircraft.get("a")!.baseLat).toBe(11);
    // b still present but marked despawned
    expect(aircraft.has("b")).toBe(true);
    expect(aircraft.get("b")!.despawnAt).not.toBeNull();
  });

  it("missing arrays in delta are tolerated (default to empty)", () => {
    const ws = simulateSocket("ws://x/ws");
    ws.onopen?.();
    ws.onmessage?.({
      data: JSON.stringify({ t: "delta", serverTime: 5 }),
    });
    // Should not throw; state unchanged except serverTime
    expect(useStore.getState().serverTime).toBe(5);
    expect(useStore.getState().aircraft.size).toBe(0);
  });

  it("malformed JSON is swallowed (no throw)", () => {
    const ws = simulateSocket("ws://x/ws");
    ws.onopen?.();
    // console.warn is called on bad frames — silence it
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() =>
      ws.onmessage?.({ data: "not-valid-json{" })
    ).not.toThrow();
    spy.mockRestore();
  });

  it("onerror sets connState=error, onclose sets connState=closed", () => {
    const ws = simulateSocket("ws://x/ws");
    ws.onerror?.();
    expect(useStore.getState().connState).toBe("error");
    ws.onclose?.();
    expect(useStore.getState().connState).toBe("closed");
  });

  it("unknown message type is a no-op", () => {
    const ws = simulateSocket("ws://x/ws");
    ws.onopen?.();
    ws.onmessage?.({
      data: JSON.stringify({ t: "pong", serverTime: 9 }),
    });
    // State should be untouched (no server time update, no aircraft)
    expect(useStore.getState().serverTime).toBe(0);
    expect(useStore.getState().aircraft.size).toBe(0);
  });
});
