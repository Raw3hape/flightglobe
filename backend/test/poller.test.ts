// Unit-тесты маппинга adsb.lol -> Aircraft.
import { describe, test, expect } from "bun:test";
import { mapRaw, type RawAircraft } from "../src/poller";

const FT_TO_M = 0.3048;
const KT_TO_MS = 0.51444;
const FTMIN_TO_MS = 0.00508;

const NOW = 1_700_000_000_000;

describe("mapRaw — базовая конверсия единиц", () => {
  test("alt_geom (feet) конвертируется в metres", () => {
    const raw: RawAircraft = {
      hex: "ABC123",
      lat: 40.5,
      lon: -73.5,
      alt_geom: 10000,
      gs: 0,
      true_heading: 0,
      baro_rate: 0,
    };
    const ac = mapRaw(raw, NOW);
    expect(ac).not.toBeNull();
    expect(ac!.altitude).toBeCloseTo(10000 * FT_TO_M, 5);
  });

  test("gs (knots) конвертируется в m/s", () => {
    const raw: RawAircraft = {
      hex: "ABC123",
      lat: 40.5,
      lon: -73.5,
      alt_geom: 1000,
      gs: 450,
    };
    const ac = mapRaw(raw, NOW);
    expect(ac!.velocity).toBeCloseTo(450 * KT_TO_MS, 5);
  });

  test("baro_rate (ft/min) конвертируется в m/s", () => {
    const raw: RawAircraft = {
      hex: "ABC123",
      lat: 40.5,
      lon: -73.5,
      alt_geom: 1000,
      baro_rate: 2000,
    };
    const ac = mapRaw(raw, NOW);
    expect(ac!.vertRate).toBeCloseTo(2000 * FTMIN_TO_MS, 5);
  });

  test("flight trim() — ведущие/хвостовые пробелы срезаются в callsign", () => {
    const raw: RawAircraft = {
      hex: "ABC123",
      lat: 40.5,
      lon: -73.5,
      flight: "  DLH441  ",
    };
    const ac = mapRaw(raw, NOW);
    expect(ac!.callsign).toBe("DLH441");
  });

  test("flight — пустая строка после trim → callsign = null", () => {
    const raw: RawAircraft = {
      hex: "ABC123",
      lat: 40.5,
      lon: -73.5,
      flight: "    ",
    };
    const ac = mapRaw(raw, NOW);
    expect(ac!.callsign).toBeNull();
  });

  test("flight отсутствует → callsign = null", () => {
    const raw: RawAircraft = {
      hex: "ABC123",
      lat: 40.5,
      lon: -73.5,
    };
    const ac = mapRaw(raw, NOW);
    expect(ac!.callsign).toBeNull();
  });
});

describe("mapRaw — onGround", () => {
  test('alt_baro === "ground" → altitude=0 и onGround=true', () => {
    const raw: RawAircraft = {
      hex: "ABC123",
      lat: 40.5,
      lon: -73.5,
      alt_baro: "ground",
      alt_geom: 500, // даже если geom что-то пишет — всё равно 0
    };
    const ac = mapRaw(raw, NOW);
    expect(ac!.onGround).toBe(true);
    expect(ac!.altitude).toBe(0);
  });

  test("alt_baro = число → onGround=false", () => {
    const raw: RawAircraft = {
      hex: "ABC123",
      lat: 40.5,
      lon: -73.5,
      alt_baro: 5000,
    };
    const ac = mapRaw(raw, NOW);
    expect(ac!.onGround).toBe(false);
    expect(ac!.altitude).toBeCloseTo(5000 * FT_TO_M, 5);
  });
});

describe("mapRaw — null/отсутствующие lat/lon", () => {
  test("lat отсутствует → null", () => {
    const raw: RawAircraft = { hex: "ABC123", lon: -73.5 };
    expect(mapRaw(raw, NOW)).toBeNull();
  });

  test("lon отсутствует → null", () => {
    const raw: RawAircraft = { hex: "ABC123", lat: 40.5 };
    expect(mapRaw(raw, NOW)).toBeNull();
  });

  test("lat = null (не number) → null", () => {
    const raw = { hex: "ABC123", lat: null, lon: -73.5 } as unknown as RawAircraft;
    expect(mapRaw(raw, NOW)).toBeNull();
  });

  test("lat=NaN → null (Number.isFinite проверка)", () => {
    const raw: RawAircraft = { hex: "ABC123", lat: NaN, lon: -73.5 };
    expect(mapRaw(raw, NOW)).toBeNull();
  });

  test("hex отсутствует → null", () => {
    const raw: RawAircraft = { lat: 40.5, lon: -73.5 };
    expect(mapRaw(raw, NOW)).toBeNull();
  });
});

describe("mapRaw — fallback heading", () => {
  test("true_heading отсутствует → используется track", () => {
    const raw: RawAircraft = {
      hex: "ABC123",
      lat: 40.5,
      lon: -73.5,
      track: 270,
    };
    const ac = mapRaw(raw, NOW);
    expect(ac!.heading).toBe(270);
  });

  test("true_heading присутствует → имеет приоритет над track", () => {
    const raw: RawAircraft = {
      hex: "ABC123",
      lat: 40.5,
      lon: -73.5,
      true_heading: 180,
      track: 90,
    };
    const ac = mapRaw(raw, NOW);
    expect(ac!.heading).toBe(180);
  });

  test("ни true_heading ни track → heading=0", () => {
    const raw: RawAircraft = {
      hex: "ABC123",
      lat: 40.5,
      lon: -73.5,
    };
    const ac = mapRaw(raw, NOW);
    expect(ac!.heading).toBe(0);
  });
});

describe("mapRaw — edge: минимальные данные", () => {
  test("только hex + lat/lon — не крашится, возвращает Aircraft с дефолтами", () => {
    const raw: RawAircraft = {
      hex: "ABC123",
      lat: 40.5,
      lon: -73.5,
    };
    const ac = mapRaw(raw, NOW);
    expect(ac).not.toBeNull();
    expect(ac!.id).toBe("abc123");
    expect(ac!.callsign).toBeNull();
    expect(ac!.country).toBeNull();
    expect(ac!.lat).toBe(40.5);
    expect(ac!.lon).toBe(-73.5);
    expect(ac!.altitude).toBe(0);
    expect(ac!.velocity).toBe(0);
    expect(ac!.heading).toBe(0);
    expect(ac!.vertRate).toBe(0);
    expect(ac!.onGround).toBe(false);
    expect(ac!.updatedAt).toBe(NOW);
  });

  test("hex приводится к нижнему регистру в id", () => {
    const raw: RawAircraft = {
      hex: "AbCdEf",
      lat: 40.5,
      lon: -73.5,
    };
    const ac = mapRaw(raw, NOW);
    expect(ac!.id).toBe("abcdef");
  });
});

describe("mapRaw — реальный sample adsb.lol", () => {
  test("типичная запись адсб.лол корректно маппится во все поля", () => {
    const raw: RawAircraft = {
      hex: "4B1805",
      flight: "SWR123  ",
      r: "HB-JVM",
      t: "A320",
      alt_baro: 35000,
      alt_geom: 35200,
      gs: 450,
      track: 270,
      true_heading: 272,
      baro_rate: -64,
      lat: 47.5,
      lon: 8.55,
    };
    const ac = mapRaw(raw, NOW);
    expect(ac).not.toBeNull();
    expect(ac!.id).toBe("4b1805");
    expect(ac!.callsign).toBe("SWR123");
    expect(ac!.lat).toBe(47.5);
    expect(ac!.lon).toBe(8.55);
    expect(ac!.altitude).toBeCloseTo(35200 * FT_TO_M, 4);
    expect(ac!.velocity).toBeCloseTo(450 * KT_TO_MS, 4);
    expect(ac!.heading).toBe(272);
    expect(ac!.vertRate).toBeCloseTo(-64 * FTMIN_TO_MS, 5);
    expect(ac!.onGround).toBe(false);
    expect(ac!.updatedAt).toBe(NOW);
  });

  test("alt_geom отсутствует → fallback на alt_baro", () => {
    const raw: RawAircraft = {
      hex: "ABC123",
      lat: 40.5,
      lon: -73.5,
      alt_baro: 4000,
    };
    const ac = mapRaw(raw, NOW);
    expect(ac!.altitude).toBeCloseTo(4000 * FT_TO_M, 5);
  });
});
