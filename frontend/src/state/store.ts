import { create } from "zustand";
import type { Aircraft } from "../protocol";

// Per-aircraft runtime state (extends server Aircraft with interpolation bits)
export type TrackedAircraft = Aircraft & {
  // Dead-reckoning base (last known truth)
  baseLat: number;
  baseLon: number;
  baseT: number; // ms when base was set (client clock)

  // Smoothing: when an update arrives, we snap base but remember the
  // last rendered (lat,lon) so we can lerp to the new base over 500 ms.
  prevRenderLat: number;
  prevRenderLon: number;
  lerpStart: number; // client ms

  // Lifecycle
  spawnedAt: number; // client ms
  despawnAt: number | null; // client ms when despawn animation started
  lastServerAt: number; // client ms of last server message

  // Server-provided trajectory history [lat, lon, alt_m, unix_ms], oldest→newest.
  // Передаётся только в hello для pre-fill трейлов на стороне клиента,
  // чтобы трассы были длинные сразу после подключения, а не накапливались
  // с момента connect. В delta не приходит.
  initialHistory?: Array<[number, number, number, number]>;
};

export type ConnState = "idle" | "connecting" | "open" | "closed" | "error";

type Store = {
  aircraft: Map<string, TrackedAircraft>;
  connState: ConnState;
  serverTime: number;
  count: number;
  applyHello: (initial: Aircraft[], serverTime: number) => void;
  applyDelta: (
    spawned: Aircraft[],
    updated: Aircraft[],
    despawned: string[],
    serverTime: number
  ) => void;
  markDespawned: (ids: string[]) => void;
  removeExpired: (ids: string[]) => void;
  setConnState: (s: ConnState) => void;
};

function toTracked(
  a: Aircraft,
  now: number,
  carryHistory: boolean
): TrackedAircraft {
  const tracked: TrackedAircraft = {
    ...a,
    baseLat: a.lat,
    baseLon: a.lon,
    baseT: now,
    prevRenderLat: a.lat,
    prevRenderLon: a.lon,
    lerpStart: now,
    spawnedAt: now,
    despawnAt: null,
    lastServerAt: now,
  };
  // Snapshot-сиду для трейлов переносим только из hello — это server-provided
  // история; в delta он не приходит, и если вдруг пришёл — игнорируем.
  if (carryHistory && a.history && a.history.length > 0) {
    // Копируем, чтобы store не держал ссылку на сырой объект из сети.
    tracked.initialHistory = a.history.slice();
  }
  // `history` — это wire-level поле протокола, не храним в runtime state.
  delete (tracked as { history?: unknown }).history;
  return tracked;
}

export const useStore = create<Store>()((set) => ({
  aircraft: new Map(),
  connState: "idle",
  serverTime: 0,
  count: 0,

  applyHello: (initial, serverTime) =>
    set(() => {
      const now = performance.now();
      const map = new Map<string, TrackedAircraft>();
      for (const a of initial) {
        map.set(a.id, toTracked(a, now, /*carryHistory*/ true));
      }
      return { aircraft: map, serverTime, count: map.size };
    }),

  applyDelta: (spawned, updated, despawned, serverTime) =>
    set((state) => {
      const now = performance.now();
      const next = new Map(state.aircraft);

      for (const a of spawned) {
        // Treat re-spawn of existing id as fresh entry. Delta никогда не несёт
        // history — initialHistory остаётся undefined.
        next.set(a.id, toTracked(a, now, /*carryHistory*/ false));
      }

      for (const a of updated) {
        const existing = next.get(a.id);
        if (!existing) {
          next.set(a.id, toTracked(a, now, /*carryHistory*/ false));
          continue;
        }
        // Snapshot current rendered position (caller is expected to
        // keep prevRenderLat/Lon roughly in sync; we set them to base
        // so the lerp starts from the previous base location, which is
        // close enough visually).
        const merged: TrackedAircraft = {
          ...existing,
          ...a,
          baseLat: a.lat,
          baseLon: a.lon,
          baseT: now,
          prevRenderLat: existing.prevRenderLat,
          prevRenderLon: existing.prevRenderLon,
          lerpStart: now,
          lastServerAt: now,
          despawnAt: null, // cancel any pending despawn if it came back
          // initialHistory не трогаем — он был выставлен при hello/spawn
          // и остаётся "seed" для трейлов на всё время жизни записи.
          initialHistory: existing.initialHistory,
        };
        // Протокольное `history` в update не приходит (см. shared/protocol.ts),
        // но на всякий случай удалим, если вдруг попало через spread.
        delete (merged as { history?: unknown }).history;
        next.set(a.id, merged);
      }

      // Server said these are gone → start despawn animation (do not remove yet)
      for (const id of despawned) {
        const ex = next.get(id);
        if (ex && ex.despawnAt == null) {
          next.set(id, { ...ex, despawnAt: now });
        }
      }

      return { aircraft: next, serverTime, count: next.size };
    }),

  markDespawned: (ids) =>
    set((state) => {
      if (!ids.length) return {};
      const now = performance.now();
      const next = new Map(state.aircraft);
      for (const id of ids) {
        const ex = next.get(id);
        if (ex && ex.despawnAt == null) {
          next.set(id, { ...ex, despawnAt: now });
        }
      }
      return { aircraft: next };
    }),

  removeExpired: (ids) =>
    set((state) => {
      if (!ids.length) return {};
      const next = new Map(state.aircraft);
      for (const id of ids) next.delete(id);
      return { aircraft: next, count: next.size };
    }),

  setConnState: (s) => set({ connState: s }),
}));
