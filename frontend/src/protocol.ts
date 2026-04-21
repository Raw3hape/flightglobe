// WebSocket protocol between backend and frontend.
// Kept in shared/ and copied into both sides at build time.

export type Aircraft = {
  id: string;            // ICAO24 hex, canonical ID
  callsign: string | null;
  country: string | null;
  lon: number;           // degrees
  lat: number;           // degrees
  altitude: number;      // meters (baro or geo)
  velocity: number;      // m/s ground speed
  heading: number;       // degrees true
  vertRate: number;      // m/s
  onGround: boolean;
  updatedAt: number;     // unix ms
  // История точек [lat, lon, alt_m, unix_ms], отсортирована oldest→newest.
  // Присутствует только в hello (initial snapshot) для клиентов, подключившихся позже
  // момента первого наблюдения этого самолёта. В delta не передаётся.
  history?: Array<[number, number, number, number]>;
};

export type ServerHello = {
  t: "hello";
  serverTime: number;
  initial: Aircraft[];   // full snapshot on connect
};

export type ServerDelta = {
  t: "delta";
  serverTime: number;
  spawned: Aircraft[];   // first time seen
  updated: Aircraft[];   // moved
  despawned: string[];   // lost (ids only)
};

export type ServerMessage = ServerHello | ServerDelta;
