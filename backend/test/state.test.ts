// Unit-тесты для AircraftState: spawned/updated/despawned + TTL + epsilon compare.
import { describe, test, expect } from "bun:test";
import { AircraftState, TTL_MS } from "../src/state";
import type { Aircraft } from "../src/protocol";

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

describe("AircraftState — пустое состояние", () => {
  test("новый стейт: пустая map и пустой snapshot", () => {
    const st = new AircraftState();
    expect(st.size()).toBe(0);
    expect(st.snapshot()).toEqual([]);
  });

  test("applySnapshot([]) → пустой diff и пустая map", () => {
    const st = new AircraftState();
    const delta = st.applySnapshot([]);
    expect(delta.t).toBe("delta");
    expect(delta.spawned).toEqual([]);
    expect(delta.updated).toEqual([]);
    expect(delta.despawned).toEqual([]);
    expect(st.size()).toBe(0);
  });
});

describe("AircraftState — spawned", () => {
  test("добавление 3 самолётов → spawned=3, updated=0, despawned=0", () => {
    const st = new AircraftState();
    const batch: Aircraft[] = [
      makeAircraft({ id: "a1" }),
      makeAircraft({ id: "a2" }),
      makeAircraft({ id: "a3" }),
    ];
    const delta = st.applySnapshot(batch);
    expect(delta.spawned).toHaveLength(3);
    expect(delta.updated).toHaveLength(0);
    expect(delta.despawned).toHaveLength(0);
    expect(st.size()).toBe(3);
    const ids = delta.spawned.map((a) => a.id).sort();
    expect(ids).toEqual(["a1", "a2", "a3"]);
  });
});

describe("AircraftState — updated", () => {
  test("обновление 1 из 3 с новой позицией → updated=1, spawned/despawned пустые", () => {
    const st = new AircraftState();
    const initial: Aircraft[] = [
      makeAircraft({ id: "a1", lon: 10, lat: 20 }),
      makeAircraft({ id: "a2", lon: 11, lat: 21 }),
      makeAircraft({ id: "a3", lon: 12, lat: 22 }),
    ];
    st.applySnapshot(initial);

    const next: Aircraft[] = [
      makeAircraft({ id: "a1", lon: 10, lat: 20 }), // не изменился
      makeAircraft({ id: "a2", lon: 11.5, lat: 21.5 }), // изменился
      makeAircraft({ id: "a3", lon: 12, lat: 22 }), // не изменился
    ];
    const delta = st.applySnapshot(next);
    expect(delta.spawned).toHaveLength(0);
    expect(delta.despawned).toHaveLength(0);
    expect(delta.updated).toHaveLength(1);
    expect(delta.updated[0].id).toBe("a2");
    expect(delta.updated[0].lon).toBe(11.5);
  });
});

describe("AircraftState — epsilon compare (позиция не изменилась)", () => {
  test("те же координаты → updated пустой, но updatedAt обновился в map", () => {
    const st = new AircraftState();
    const t1 = 1_000_000;
    st.applySnapshot([makeAircraft({ id: "a1", lon: 10, lat: 20, updatedAt: t1 })]);

    const t2 = t1 + 5_000;
    const delta = st.applySnapshot([
      makeAircraft({ id: "a1", lon: 10, lat: 20, updatedAt: t2 }),
    ]);

    expect(delta.updated).toHaveLength(0);
    expect(delta.spawned).toHaveLength(0);
    expect(delta.despawned).toHaveLength(0);

    // Но updatedAt должен был обновиться в текущей map — иначе сломается TTL
    const stored = st.map.get("a1")!;
    expect(stored.updatedAt).toBe(t2);
  });

  test("изменение позиции ниже эпсилон → не попадает в updated", () => {
    const st = new AircraftState();
    st.applySnapshot([makeAircraft({ id: "a1", lon: 10.0, lat: 20.0 })]);

    // Сдвиг меньше 1e-6 — должно считаться "той же позицией"
    const delta = st.applySnapshot([
      makeAircraft({ id: "a1", lon: 10.0 + 1e-8, lat: 20.0 + 1e-8 }),
    ]);
    expect(delta.updated).toHaveLength(0);
  });
});

describe("AircraftState — TTL despawned", () => {
  test("самолёт отсутствует в incoming и просрочен по TTL → despawned + удалён из map", () => {
    const st = new AircraftState();

    // Фиксируем старое время для a1
    const longAgo = Date.now() - (TTL_MS + 10_000);
    // Вставим напрямую через applySnapshot с "протухшим" updatedAt
    st.applySnapshot([makeAircraft({ id: "a1", updatedAt: longAgo })]);
    expect(st.size()).toBe(1);

    // Следующий snapshot не содержит a1 и ttl истёк
    const delta = st.applySnapshot([]);
    expect(delta.despawned).toEqual(["a1"]);
    expect(st.size()).toBe(0);
    expect(st.map.has("a1")).toBe(false);
  });

  test("самолёт отсутствует в incoming, но TTL ещё не истёк → в despawned НЕ попадает, остаётся в map", () => {
    const st = new AircraftState();
    const recent = Date.now();
    st.applySnapshot([makeAircraft({ id: "a1", updatedAt: recent })]);

    const delta = st.applySnapshot([]);
    expect(delta.despawned).toEqual([]);
    expect(st.size()).toBe(1);
  });

  test("видимый в snapshot самолёт не попадает в despawned даже если raw updatedAt старый", () => {
    const st = new AircraftState();
    // Сначала добавим с "протухшим" updatedAt
    const longAgo = Date.now() - (TTL_MS + 10_000);
    st.applySnapshot([makeAircraft({ id: "a1", updatedAt: longAgo })]);

    // Но теперь он опять в incoming — НЕ despawn
    const delta = st.applySnapshot([
      makeAircraft({ id: "a1", updatedAt: Date.now() }),
    ]);
    expect(delta.despawned).toEqual([]);
    expect(st.size()).toBe(1);
  });
});

describe("AircraftState — diff учитывает только видимые/невидимые", () => {
  test("логика 'был/нет' корректна для смешанной ситуации", () => {
    const st = new AircraftState();
    const now = Date.now();

    // Инициал: a1, a2 (a1 свежий, a2 с просроченным updatedAt)
    st.applySnapshot([
      makeAircraft({ id: "a1", lon: 1, lat: 1, updatedAt: now - (TTL_MS + 1_000) }),
      makeAircraft({ id: "a2", lon: 2, lat: 2, updatedAt: now - (TTL_MS + 1_000) }),
    ]);

    // Следующий: только a1 (с новой позицией), a3 — новый, a2 пропал и истёк
    const delta = st.applySnapshot([
      makeAircraft({ id: "a1", lon: 1.5, lat: 1.5, updatedAt: now }),
      makeAircraft({ id: "a3", lon: 3, lat: 3, updatedAt: now }),
    ]);
    expect(delta.spawned.map((a) => a.id)).toEqual(["a3"]);
    expect(delta.updated.map((a) => a.id)).toEqual(["a1"]);
    expect(delta.despawned).toEqual(["a2"]);
    expect(st.size()).toBe(2);
  });
});

describe("AircraftState — snapshot()", () => {
  test("возвращает все Aircraft в map", () => {
    const st = new AircraftState();
    st.applySnapshot([
      makeAircraft({ id: "a1" }),
      makeAircraft({ id: "a2" }),
    ]);
    const snap = st.snapshot();
    expect(snap).toHaveLength(2);
    const ids = snap.map((a) => a.id).sort();
    expect(ids).toEqual(["a1", "a2"]);
  });
});
