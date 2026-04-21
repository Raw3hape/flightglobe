// Управление Map<id, Aircraft> + вычисление diff + TTL.
import type { Aircraft, ServerDelta } from "./protocol";

// TTL: самолёт считается despawned если не обновлялся больше TTL_MS.
export const TTL_MS = 30_000;

// Порог изменения позиции/параметров для попадания в updated.
// Мы сравниваем по lon/lat/altitude/heading/velocity/onGround/vertRate.
// Фронтенд будет интерполировать, поэтому шлём обновление на любое изменение
// приходящих из API чисел (adsb.lol уже агрегирует, сильно лишнего не будет).
const POS_EPSILON = 1e-6; // примерно ~0.1 м по широте

function samePosition(a: Aircraft, b: Aircraft): boolean {
  return (
    Math.abs(a.lon - b.lon) < POS_EPSILON &&
    Math.abs(a.lat - b.lat) < POS_EPSILON &&
    Math.abs(a.altitude - b.altitude) < 0.5 &&
    Math.abs(a.heading - b.heading) < 0.5 &&
    Math.abs(a.velocity - b.velocity) < 0.5 &&
    Math.abs(a.vertRate - b.vertRate) < 0.1 &&
    a.onGround === b.onGround
  );
}

export class AircraftState {
  // Текущее состояние: id -> Aircraft
  map: Map<string, Aircraft> = new Map();

  /**
   * Применяет свежий batch от API и возвращает дельту относительно предыдущего состояния.
   * - spawned: id которых не было в prev map
   * - updated: id которые были, но позиция/параметры изменились
   * - despawned: id которых нет в incoming и которые устарели по TTL (либо просто нет в incoming — в этом случае тоже удаляем)
   *
   * adsb.lol отдаёт весь мир разом, поэтому самолёт отсутствующий в incoming либо
   * приземлился/выключил транспондер, либо вышел за пределы сети. Удаляем сразу,
   * если last updatedAt > TTL_MS.
   */
  applySnapshot(incoming: Aircraft[]): ServerDelta {
    const now = Date.now();
    const spawned: Aircraft[] = [];
    const updated: Aircraft[] = [];
    const despawned: string[] = [];

    // Быстрый индекс входящих
    const incomingIds = new Set<string>();

    for (const fresh of incoming) {
      incomingIds.add(fresh.id);
      const prev = this.map.get(fresh.id);
      if (!prev) {
        spawned.push(fresh);
        this.map.set(fresh.id, fresh);
      } else if (!samePosition(prev, fresh)) {
        updated.push(fresh);
        this.map.set(fresh.id, fresh);
      } else {
        // Позиция та же — обновим только updatedAt чтобы не словить TTL
        prev.updatedAt = fresh.updatedAt;
      }
    }

    // Проверка TTL для самолётов, которых нет в incoming
    for (const [id, ac] of this.map) {
      if (!incomingIds.has(id) && now - ac.updatedAt > TTL_MS) {
        despawned.push(id);
      }
    }
    for (const id of despawned) {
      this.map.delete(id);
    }

    return {
      t: "delta",
      serverTime: now,
      spawned,
      updated,
      despawned,
    };
  }

  /**
   * Полный снимок для ServerHello.
   */
  snapshot(): Aircraft[] {
    return Array.from(this.map.values());
  }

  size(): number {
    return this.map.size;
  }
}
