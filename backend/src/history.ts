// Ring-buffer накопления исторических позиций самолётов.
// Каждая точка — [lat, lon, alt_m, unix_ms], хранится oldest→newest.

// Максимум точек в истории на самолёт: 60 × 5 сек = 5 минут.
export const HISTORY_LEN = 60;

// TTL после последней observation: если самолёт не обновлялся 30 мин — чистим кольцо.
export const HISTORY_TTL_MS = 30 * 60_000;

// Эпсилон для сравнения "та же позиция": ~0.1 м по широте.
const POS_EPSILON = 1e-6;

export type HistoryPoint = [number, number, number, number];

type Ring = {
  pts: HistoryPoint[];
  lastT: number;
};

export class HistoryStore {
  private rings: Map<string, Ring> = new Map();

  /**
   * Записывает позицию в ring-buffer самолёта.
   * Если последняя точка имеет ту же позицию (по lat/lon с эпсилон), новая точка
   * НЕ добавляется — только обновляется lastT (чтобы stale rings очищались корректно).
   * При превышении HISTORY_LEN дропается oldest.
   */
  record(id: string, lat: number, lon: number, alt: number, t: number): void {
    let ring = this.rings.get(id);
    if (!ring) {
      ring = { pts: [], lastT: t };
      this.rings.set(id, ring);
    }

    ring.lastT = t;

    // Epsilon-check: если последняя точка в той же позиции — не засоряем историю.
    const last = ring.pts.length > 0 ? ring.pts[ring.pts.length - 1] : null;
    if (
      last !== null &&
      Math.abs(last[0] - lat) < POS_EPSILON &&
      Math.abs(last[1] - lon) < POS_EPSILON
    ) {
      return;
    }

    ring.pts.push([lat, lon, alt, t]);
    // Circular buffer: drop oldest при переполнении.
    if (ring.pts.length > HISTORY_LEN) {
      ring.pts.shift();
    }
  }

  /**
   * Возвращает копию массива точек (oldest→newest) или undefined если истории нет.
   * Модификация возвращённого массива НЕ влияет на стор.
   */
  getHistory(id: string): HistoryPoint[] | undefined {
    const ring = this.rings.get(id);
    if (!ring || ring.pts.length === 0) return undefined;
    // Копия массива и каждой точки (чтобы caller не мог повлиять на store).
    return ring.pts.map((p) => [p[0], p[1], p[2], p[3]] as HistoryPoint);
  }

  /**
   * Удаляет rings самолётов, у которых lastT старше HISTORY_TTL_MS.
   * Возвращает количество удалённых.
   */
  cleanup(now: number): number {
    let removed = 0;
    for (const [id, ring] of this.rings) {
      if (now - ring.lastT > HISTORY_TTL_MS) {
        this.rings.delete(id);
        removed++;
      }
    }
    return removed;
  }

  size(): number {
    return this.rings.size;
  }
}
