import { describe, it, expect, beforeEach } from "vitest";
import { useStore } from "./store";
import type { Aircraft } from "../protocol";

function makeAircraft(overrides: Partial<Aircraft> = {}): Aircraft {
  return {
    id: "AAA111",
    callsign: "TEST1",
    country: "US",
    lon: 10,
    lat: 20,
    altitude: 10000,
    velocity: 250,
    heading: 90,
    vertRate: 0,
    onGround: false,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  };
}

// Full reset between tests: since zustand state is module-level, we
// explicitly set store back to initial.
function resetStore() {
  useStore.setState({
    aircraft: new Map(),
    connState: "idle",
    serverTime: 0,
    count: 0,
  });
}

describe("store — initial state", () => {
  beforeEach(() => resetStore());

  it("aircraft is an empty Map", () => {
    const { aircraft } = useStore.getState();
    expect(aircraft).toBeInstanceOf(Map);
    expect(aircraft.size).toBe(0);
  });

  it("count = 0, serverTime = 0", () => {
    const { count, serverTime } = useStore.getState();
    expect(count).toBe(0);
    expect(serverTime).toBe(0);
  });
});

describe("setConnState", () => {
  beforeEach(() => resetStore());

  it("updates connection state", () => {
    useStore.getState().setConnState("connecting");
    expect(useStore.getState().connState).toBe("connecting");
    useStore.getState().setConnState("open");
    expect(useStore.getState().connState).toBe("open");
  });
});

describe("applyHello", () => {
  beforeEach(() => resetStore());

  it("fills Map with tracked aircraft from initial snapshot", () => {
    const a = makeAircraft({ id: "a", lat: 1, lon: 2 });
    const b = makeAircraft({ id: "b", lat: 3, lon: 4 });
    const c = makeAircraft({ id: "c", lat: 5, lon: 6 });

    useStore.getState().applyHello([a, b, c], 12345);
    const { aircraft, count, serverTime } = useStore.getState();

    expect(aircraft.size).toBe(3);
    expect(count).toBe(3);
    expect(serverTime).toBe(12345);
    expect(aircraft.has("a")).toBe(true);
    expect(aircraft.has("b")).toBe(true);
    expect(aircraft.has("c")).toBe(true);
  });

  it("each tracked aircraft has baseLat/baseLon/spawnedAt/prevRender/lerpStart set", () => {
    const a = makeAircraft({ id: "a", lat: 11, lon: 22 });
    useStore.getState().applyHello([a], 1);
    const tracked = useStore.getState().aircraft.get("a")!;

    expect(tracked.baseLat).toBe(11);
    expect(tracked.baseLon).toBe(22);
    expect(tracked.prevRenderLat).toBe(11);
    expect(tracked.prevRenderLon).toBe(22);
    expect(typeof tracked.spawnedAt).toBe("number");
    expect(typeof tracked.lerpStart).toBe("number");
    expect(typeof tracked.baseT).toBe("number");
    expect(typeof tracked.lastServerAt).toBe("number");
    expect(tracked.despawnAt).toBeNull();
  });

  it("replaces existing Map on fresh hello", () => {
    useStore.getState().applyHello([makeAircraft({ id: "old" })], 0);
    expect(useStore.getState().aircraft.has("old")).toBe(true);

    useStore.getState().applyHello([makeAircraft({ id: "new" })], 1);
    expect(useStore.getState().aircraft.has("old")).toBe(false);
    expect(useStore.getState().aircraft.has("new")).toBe(true);
  });

  it("handles empty snapshot", () => {
    useStore.getState().applyHello([], 99);
    expect(useStore.getState().aircraft.size).toBe(0);
    expect(useStore.getState().count).toBe(0);
    expect(useStore.getState().serverTime).toBe(99);
  });
});

describe("applyHello — server-provided history → initialHistory", () => {
  beforeEach(() => resetStore());

  it("copies Aircraft.history into tracked.initialHistory", () => {
    const history: Array<[number, number, number, number]> = [
      [10, 20, 9000, 1_700_000_000_000],
      [10.1, 20.1, 9100, 1_700_000_002_000],
      [10.2, 20.2, 9200, 1_700_000_004_000],
    ];
    const a = makeAircraft({ id: "a", history });
    useStore.getState().applyHello([a], 0);
    const tracked = useStore.getState().aircraft.get("a")!;

    expect(tracked.initialHistory).toBeDefined();
    expect(tracked.initialHistory!.length).toBe(3);
    expect(tracked.initialHistory![0]).toEqual([10, 20, 9000, 1_700_000_000_000]);
    expect(tracked.initialHistory![2]).toEqual([10.2, 20.2, 9200, 1_700_000_004_000]);
  });

  it("initialHistory is a copy, not reference to network payload", () => {
    const history: Array<[number, number, number, number]> = [
      [1, 2, 3, 4],
    ];
    const a = makeAircraft({ id: "a", history });
    useStore.getState().applyHello([a], 0);
    const tracked = useStore.getState().aircraft.get("a")!;

    // Мутируем исходный массив — store должен быть не затронут.
    history.push([99, 99, 99, 99]);
    expect(tracked.initialHistory!.length).toBe(1);
  });

  it("no history on Aircraft → initialHistory is undefined", () => {
    const a = makeAircraft({ id: "a" });
    // history намеренно не выставлен
    useStore.getState().applyHello([a], 0);
    const tracked = useStore.getState().aircraft.get("a")!;

    expect(tracked.initialHistory).toBeUndefined();
  });

  it("empty history array → initialHistory is undefined (empty seed бесполезен)", () => {
    const a = makeAircraft({ id: "a", history: [] });
    useStore.getState().applyHello([a], 0);
    const tracked = useStore.getState().aircraft.get("a")!;

    expect(tracked.initialHistory).toBeUndefined();
  });

  it("wire-level `history` field не остаётся в tracked state", () => {
    const history: Array<[number, number, number, number]> = [[1, 2, 3, 4]];
    const a = makeAircraft({ id: "a", history });
    useStore.getState().applyHello([a], 0);
    const tracked = useStore.getState().aircraft.get("a")!;

    // initialHistory — единственный runtime-владелец истории.
    expect((tracked as unknown as { history?: unknown }).history).toBeUndefined();
    expect(tracked.initialHistory).toBeDefined();
  });
});

describe("applyDelta", () => {
  beforeEach(() => resetStore());

  it("spawned aircraft added to Map with fresh tracked state", () => {
    useStore
      .getState()
      .applyHello([makeAircraft({ id: "a" })], 0);

    const d = makeAircraft({ id: "d", lat: 50, lon: 60 });
    useStore.getState().applyDelta([d], [], [], 10);

    const { aircraft, count } = useStore.getState();
    expect(aircraft.has("d")).toBe(true);
    expect(count).toBe(2);
    const dTracked = aircraft.get("d")!;
    expect(dTracked.baseLat).toBe(50);
    expect(dTracked.baseLon).toBe(60);
    expect(dTracked.despawnAt).toBeNull();
    expect(typeof dTracked.spawnedAt).toBe("number");
  });

  it("updated aircraft: baseLat/baseLon/velocity/heading refreshed, lerpStart advanced", async () => {
    const original = makeAircraft({
      id: "a",
      lat: 10,
      lon: 20,
      velocity: 100,
      heading: 45,
    });
    useStore.getState().applyHello([original], 0);
    const before = useStore.getState().aircraft.get("a")!;
    const beforeLerp = before.lerpStart;
    const beforeSpawn = before.spawnedAt;

    // Wait a tick so performance.now() advances
    await new Promise((r) => setTimeout(r, 5));

    const updated = makeAircraft({
      id: "a",
      lat: 11,
      lon: 21,
      velocity: 200,
      heading: 90,
    });
    useStore.getState().applyDelta([], [updated], [], 5);

    const after = useStore.getState().aircraft.get("a")!;
    expect(after.baseLat).toBe(11);
    expect(after.baseLon).toBe(21);
    expect(after.velocity).toBe(200);
    expect(after.heading).toBe(90);
    expect(after.lerpStart).toBeGreaterThan(beforeLerp);
    // spawnedAt must NOT reset on update
    expect(after.spawnedAt).toBe(beforeSpawn);
    expect(after.despawnAt).toBeNull();
  });

  it("updated aircraft for unknown id is spawned as new", () => {
    useStore.getState().applyHello([], 0);
    const a = makeAircraft({ id: "never-seen", lat: 1, lon: 2 });
    useStore.getState().applyDelta([], [a], [], 1);

    const tracked = useStore.getState().aircraft.get("never-seen");
    expect(tracked).toBeDefined();
    expect(tracked!.baseLat).toBe(1);
    expect(tracked!.baseLon).toBe(2);
  });

  it("despawned aircraft gets despawnAt = now, but stays in Map (for animation)", () => {
    useStore
      .getState()
      .applyHello(
        [makeAircraft({ id: "a" }), makeAircraft({ id: "b" })],
        0
      );
    useStore.getState().applyDelta([], [], ["b"], 1);

    const { aircraft, count } = useStore.getState();
    // b is still present
    expect(aircraft.has("b")).toBe(true);
    const b = aircraft.get("b")!;
    expect(b.despawnAt).not.toBeNull();
    expect(typeof b.despawnAt).toBe("number");
    // count reflects Map.size (b still in Map)
    expect(count).toBe(aircraft.size);
  });

  it("despawn on unknown id is a no-op", () => {
    useStore.getState().applyHello([makeAircraft({ id: "a" })], 0);
    const before = useStore.getState().aircraft.size;
    useStore.getState().applyDelta([], [], ["unknown"], 1);
    expect(useStore.getState().aircraft.size).toBe(before);
    expect(useStore.getState().aircraft.has("a")).toBe(true);
  });

  it("despawn does not overwrite an existing despawnAt", async () => {
    useStore.getState().applyHello([makeAircraft({ id: "a" })], 0);
    useStore.getState().applyDelta([], [], ["a"], 1);
    const firstDespawn = useStore.getState().aircraft.get("a")!.despawnAt;
    expect(firstDespawn).not.toBeNull();

    await new Promise((r) => setTimeout(r, 5));

    useStore.getState().applyDelta([], [], ["a"], 2);
    const secondDespawn = useStore.getState().aircraft.get("a")!.despawnAt;
    expect(secondDespawn).toBe(firstDespawn);
  });

  it("update on a previously despawned aircraft cancels its despawnAt", () => {
    useStore.getState().applyHello([makeAircraft({ id: "a" })], 0);
    useStore.getState().applyDelta([], [], ["a"], 1);
    expect(useStore.getState().aircraft.get("a")!.despawnAt).not.toBeNull();

    useStore
      .getState()
      .applyDelta([], [makeAircraft({ id: "a", lat: 77 })], [], 2);
    const a = useStore.getState().aircraft.get("a")!;
    expect(a.despawnAt).toBeNull();
    expect(a.baseLat).toBe(77);
  });

  it("re-spawn of existing id resets tracked state (fresh spawnedAt)", async () => {
    useStore.getState().applyHello([makeAircraft({ id: "a" })], 0);
    const before = useStore.getState().aircraft.get("a")!.spawnedAt;

    await new Promise((r) => setTimeout(r, 5));

    useStore
      .getState()
      .applyDelta([makeAircraft({ id: "a", lat: 99 })], [], [], 10);
    const after = useStore.getState().aircraft.get("a")!;
    expect(after.spawnedAt).toBeGreaterThan(before);
    expect(after.baseLat).toBe(99);
  });

  it("updates serverTime and count", () => {
    useStore.getState().applyHello([makeAircraft({ id: "a" })], 0);
    useStore.getState().applyDelta([makeAircraft({ id: "b" })], [], [], 777);
    expect(useStore.getState().serverTime).toBe(777);
    expect(useStore.getState().count).toBe(2);
  });
});

describe("applyDelta — initialHistory never set from delta", () => {
  beforeEach(() => resetStore());

  it("spawned: history in delta payload is ignored → initialHistory undefined", () => {
    useStore.getState().applyHello([], 0);

    // Сервер, по протоколу, не шлёт history в delta. Но если вдруг прилетит —
    // seed не должен попасть в tracked state (истина о траектории для новых
    // spawn'ов создаётся только в hello).
    const spawned = makeAircraft({
      id: "x",
      history: [
        [1, 2, 3, 4],
        [5, 6, 7, 8],
      ],
    });
    useStore.getState().applyDelta([spawned], [], [], 1);
    const tracked = useStore.getState().aircraft.get("x")!;

    expect(tracked.initialHistory).toBeUndefined();
  });

  it("spawned without history: initialHistory undefined", () => {
    useStore.getState().applyHello([], 0);
    useStore
      .getState()
      .applyDelta([makeAircraft({ id: "y" })], [], [], 1);
    const tracked = useStore.getState().aircraft.get("y")!;
    expect(tracked.initialHistory).toBeUndefined();
  });

  it("updated for unknown id (spawn-as-new): initialHistory undefined", () => {
    useStore.getState().applyHello([], 0);
    // даже если бы в payload случайно оказалось history — delta его игнорит
    const updated = makeAircraft({
      id: "z",
      history: [[10, 20, 30, 40]],
    });
    useStore.getState().applyDelta([], [updated], [], 1);
    const tracked = useStore.getState().aircraft.get("z")!;
    expect(tracked.initialHistory).toBeUndefined();
  });

  it("update of existing aircraft preserves hello-seeded initialHistory", () => {
    const helloHistory: Array<[number, number, number, number]> = [
      [10, 20, 100, 1_000],
      [10.5, 20.5, 110, 1_002],
    ];
    useStore
      .getState()
      .applyHello([makeAircraft({ id: "a", history: helloHistory })], 0);
    const before = useStore.getState().aircraft.get("a")!;
    expect(before.initialHistory).toBeDefined();
    expect(before.initialHistory!.length).toBe(2);

    // Обновление не должно ни обнулить, ни перезаписать seed.
    useStore
      .getState()
      .applyDelta([], [makeAircraft({ id: "a", lat: 33 })], [], 1);
    const after = useStore.getState().aircraft.get("a")!;

    expect(after.baseLat).toBe(33);
    expect(after.initialHistory).toBeDefined();
    expect(after.initialHistory!.length).toBe(2);
    expect(after.initialHistory![0]).toEqual([10, 20, 100, 1_000]);
  });

  it("re-spawn сбрасывает initialHistory (delta не несёт history)", () => {
    const helloHistory: Array<[number, number, number, number]> = [
      [10, 20, 100, 1_000],
    ];
    useStore
      .getState()
      .applyHello([makeAircraft({ id: "a", history: helloHistory })], 0);
    expect(useStore.getState().aircraft.get("a")!.initialHistory).toBeDefined();

    // Полный re-spawn через delta.spawned очищает seed (свежая tracked запись).
    useStore
      .getState()
      .applyDelta([makeAircraft({ id: "a", lat: 77 })], [], [], 1);
    const after = useStore.getState().aircraft.get("a")!;
    expect(after.baseLat).toBe(77);
    expect(after.initialHistory).toBeUndefined();
  });

  it("runtime `history` поле не утекает в tracked state после update", () => {
    useStore.getState().applyHello([makeAircraft({ id: "a" })], 0);
    const updated = makeAircraft({
      id: "a",
      lat: 55,
      history: [[1, 2, 3, 4]],
    });
    useStore.getState().applyDelta([], [updated], [], 1);
    const after = useStore.getState().aircraft.get("a")!;

    expect((after as unknown as { history?: unknown }).history).toBeUndefined();
  });
});

describe("markDespawned", () => {
  beforeEach(() => resetStore());

  it("sets despawnAt for given ids", () => {
    useStore
      .getState()
      .applyHello(
        [makeAircraft({ id: "a" }), makeAircraft({ id: "b" })],
        0
      );
    useStore.getState().markDespawned(["a", "b"]);
    const { aircraft } = useStore.getState();
    expect(aircraft.get("a")!.despawnAt).not.toBeNull();
    expect(aircraft.get("b")!.despawnAt).not.toBeNull();
  });

  it("empty ids is a no-op", () => {
    useStore.getState().applyHello([makeAircraft({ id: "a" })], 0);
    useStore.getState().markDespawned([]);
    expect(useStore.getState().aircraft.get("a")!.despawnAt).toBeNull();
  });

  it("unknown ids ignored, others still marked", () => {
    useStore.getState().applyHello([makeAircraft({ id: "a" })], 0);
    useStore.getState().markDespawned(["a", "ghost"]);
    const { aircraft } = useStore.getState();
    expect(aircraft.get("a")!.despawnAt).not.toBeNull();
    expect(aircraft.has("ghost")).toBe(false);
  });

  it("does not overwrite existing despawnAt", async () => {
    useStore.getState().applyHello([makeAircraft({ id: "a" })], 0);
    useStore.getState().markDespawned(["a"]);
    const first = useStore.getState().aircraft.get("a")!.despawnAt!;

    await new Promise((r) => setTimeout(r, 5));

    useStore.getState().markDespawned(["a"]);
    const second = useStore.getState().aircraft.get("a")!.despawnAt!;
    expect(second).toBe(first);
  });
});

describe("removeExpired", () => {
  beforeEach(() => resetStore());

  it("removes given ids from Map", () => {
    useStore
      .getState()
      .applyHello(
        [
          makeAircraft({ id: "a" }),
          makeAircraft({ id: "b" }),
          makeAircraft({ id: "c" }),
        ],
        0
      );
    useStore.getState().removeExpired(["b", "c"]);
    const { aircraft, count } = useStore.getState();
    expect(aircraft.has("a")).toBe(true);
    expect(aircraft.has("b")).toBe(false);
    expect(aircraft.has("c")).toBe(false);
    expect(count).toBe(1);
  });

  it("empty ids is a no-op", () => {
    useStore.getState().applyHello([makeAircraft({ id: "a" })], 0);
    useStore.getState().removeExpired([]);
    expect(useStore.getState().aircraft.size).toBe(1);
  });

  it("unknown ids ignored (no throw)", () => {
    useStore.getState().applyHello([makeAircraft({ id: "a" })], 0);
    expect(() => useStore.getState().removeExpired(["zzz"])).not.toThrow();
    expect(useStore.getState().aircraft.has("a")).toBe(true);
  });

  it("count stays in sync with Map.size after removal", () => {
    useStore
      .getState()
      .applyHello(
        [makeAircraft({ id: "a" }), makeAircraft({ id: "b" })],
        0
      );
    useStore.getState().removeExpired(["a"]);
    expect(useStore.getState().count).toBe(1);
    expect(useStore.getState().aircraft.size).toBe(1);
  });
});
