// Fetch-петля к adsb.lol + маппинг сырых записей в Aircraft.
import type { Aircraft } from "./protocol";
import { AircraftState } from "./state";
import { HistoryStore } from "./history";

const API_URL = "https://api.adsb.lol/v2/lat/0/lon/0/dist/10000";
const POLL_INTERVAL_MS = 5_000;
const MAX_BACKOFF_MS = 30_000;
const FETCH_TIMEOUT_MS = 15_000;

// Единицы
const FT_TO_M = 0.3048;
const KT_TO_MS = 0.51444;
const FTMIN_TO_MS = 0.00508;

export type RawAircraft = {
  hex?: string;
  flight?: string;
  r?: string;
  t?: string;
  alt_baro?: number | "ground";
  alt_geom?: number;
  gs?: number;
  track?: number;
  true_heading?: number;
  baro_rate?: number;
  lat?: number;
  lon?: number;
};

type RawPayload = {
  ac?: RawAircraft[];
  now?: number;
  total?: number;
};

/**
 * Маппинг сырой записи adsb.lol -> Aircraft (или null если данные неполные).
 */
export function mapRaw(raw: RawAircraft, now: number): Aircraft | null {
  if (!raw.hex) return null;
  if (typeof raw.lat !== "number" || typeof raw.lon !== "number") return null;
  if (!Number.isFinite(raw.lat) || !Number.isFinite(raw.lon)) return null;

  const onGround = raw.alt_baro === "ground";

  // Высота: предпочитаем geom, потом baro; если ground — 0.
  let altitude = 0;
  if (!onGround) {
    const altFt =
      typeof raw.alt_geom === "number"
        ? raw.alt_geom
        : typeof raw.alt_baro === "number"
        ? raw.alt_baro
        : 0;
    altitude = altFt * FT_TO_M;
  }

  const velocity = (typeof raw.gs === "number" ? raw.gs : 0) * KT_TO_MS;

  const heading =
    typeof raw.true_heading === "number"
      ? raw.true_heading
      : typeof raw.track === "number"
      ? raw.track
      : 0;

  const vertRate = (typeof raw.baro_rate === "number" ? raw.baro_rate : 0) * FTMIN_TO_MS;

  const callsignRaw = typeof raw.flight === "string" ? raw.flight.trim() : "";
  const callsign = callsignRaw.length > 0 ? callsignRaw : null;

  return {
    id: raw.hex.toLowerCase(),
    callsign,
    country: null,
    lon: raw.lon,
    lat: raw.lat,
    altitude,
    velocity,
    heading,
    vertRate,
    onGround,
    updatedAt: now,
  };
}

async function fetchWithTimeout(url: string, ms: number): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    // Bun's fetch автоматически декомпрессит gzip.
    return await fetch(url, {
      signal: ctrl.signal,
      headers: {
        "User-Agent": "tracking-backend/0.1 (Bun)",
        Accept: "application/json",
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

export type PollerCallbacks = {
  onDelta: (delta: ReturnType<AircraftState["applySnapshot"]>) => void;
};

export class Poller {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private consecutiveFailures = 0;

  constructor(
    private state: AircraftState,
    private cb: PollerCallbacks,
    private history: HistoryStore | null = null,
  ) {}

  start(): void {
    this.stopped = false;
    // первый тик — немедленно
    this.tick();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private scheduleNext(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => this.tick(), delayMs);
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;
    const started = Date.now();
    try {
      const res = await fetchWithTimeout(API_URL, FETCH_TIMEOUT_MS);
      if (!res.ok) {
        throw new Error(`adsb.lol returned HTTP ${res.status}`);
      }
      const data = (await res.json()) as RawPayload;
      const rawList = Array.isArray(data.ac) ? data.ac : [];
      const now = Date.now();

      const mapped: Aircraft[] = [];
      for (const raw of rawList) {
        const ac = mapRaw(raw, now);
        if (ac) {
          mapped.push(ac);
          // Записываем позицию в историю (только для валидно смапленных самолётов).
          if (this.history) {
            this.history.record(ac.id, ac.lat, ac.lon, ac.altitude, now);
          }
        }
      }

      const delta = this.state.applySnapshot(mapped);

      const took = Date.now() - started;
      console.log(
        `[poller] ok: raw=${rawList.length} mapped=${mapped.length} ` +
          `total=${this.state.size()} spawned=${delta.spawned.length} ` +
          `updated=${delta.updated.length} despawned=${delta.despawned.length} ` +
          `history=${this.history ? this.history.size() : 0} ` +
          `(${took}ms)`,
      );

      this.cb.onDelta(delta);
      this.consecutiveFailures = 0;
      this.scheduleNext(POLL_INTERVAL_MS);
    } catch (err) {
      this.consecutiveFailures++;
      const backoff = Math.min(
        MAX_BACKOFF_MS,
        POLL_INTERVAL_MS * Math.pow(2, this.consecutiveFailures - 1),
      );
      console.error(
        `[poller] fetch failed (attempt ${this.consecutiveFailures}): ${
          err instanceof Error ? err.message : String(err)
        } — retry in ${backoff}ms`,
      );
      this.scheduleNext(backoff);
    }
  }
}
