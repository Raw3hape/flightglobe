import { describe, it, expect } from "vitest";
import {
  latLonToVec3,
  latLonAltToVec3,
  greatCircleStep,
  GLOBE_RADIUS,
  R_EARTH_M,
} from "./geo";

const EPS = 1e-9;

function near(actual: number, expected: number, tol = 1e-9) {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tol);
}

describe("latLonToVec3", () => {
  it("lat=0, lon=0 → (1, 0, 0) on unit sphere", () => {
    const v = latLonToVec3(0, 0, 1);
    near(v.x, 1, EPS);
    near(v.y, 0, EPS);
    near(v.z, 0, EPS);
  });

  it("lat=90 (north pole) → (0, 1, 0)", () => {
    const v = latLonToVec3(90, 0, 1);
    near(v.x, 0, 1e-9);
    near(v.y, 1, EPS);
    near(v.z, 0, 1e-9);
  });

  it("lat=-90 (south pole) → (0, -1, 0)", () => {
    const v = latLonToVec3(-90, 0, 1);
    near(v.x, 0, 1e-9);
    near(v.y, -1, EPS);
    near(v.z, 0, 1e-9);
  });

  it("radius scales output length", () => {
    const v = latLonToVec3(0, 45, 2);
    const len = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
    near(len, 2, 1e-9);
  });

  it("all points are on a sphere of given radius", () => {
    const cases: [number, number][] = [
      [10, 20],
      [45, -90],
      [-30, 120],
      [89, 0],
      [0, 180],
      [-45, -179],
    ];
    for (const [lat, lon] of cases) {
      const v = latLonToVec3(lat, lon, GLOBE_RADIUS);
      const len = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
      near(len, GLOBE_RADIUS, 1e-9);
    }
  });

  it("uses GLOBE_RADIUS by default", () => {
    const v = latLonToVec3(0, 0);
    const len = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
    near(len, GLOBE_RADIUS, 1e-9);
  });

  it("writes into provided 'out' vector instead of allocating", () => {
    const out = { x: 0, y: 0, z: 0, isVector3: true } as any;
    // Use a real three Vector3 via helper to be safe; instantiate by calling default path first
    const v1 = latLonToVec3(0, 0, 1);
    // Pass it back to itself — should mutate in place
    const v2 = latLonToVec3(30, 40, 1, v1);
    expect(v2).toBe(v1);
  });
});

describe("latLonAltToVec3", () => {
  it("altitude=0 → r = 1.003 (slightly above GLOBE_RADIUS)", () => {
    const v = latLonAltToVec3(0, 0, 0);
    const len = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
    near(len, GLOBE_RADIUS + 0.003, 1e-9);
  });

  it("altitude=12000 → r > base r", () => {
    const base = latLonAltToVec3(0, 0, 0);
    const high = latLonAltToVec3(0, 0, 12000);
    const lenBase = Math.sqrt(
      base.x * base.x + base.y * base.y + base.z * base.z
    );
    const lenHigh = Math.sqrt(
      high.x * high.x + high.y * high.y + high.z * high.z
    );
    expect(lenHigh).toBeGreaterThan(lenBase);
    // r = 1.003 + 12000 * 1e-5 = 1.003 + 0.12 = 1.123
    near(lenHigh, 1.123, 1e-9);
  });

  it("altitude is linear in r", () => {
    const lenAt = (alt: number) => {
      const v = latLonAltToVec3(0, 0, alt);
      return Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
    };
    const l1 = lenAt(1000);
    const l2 = lenAt(2000);
    const l3 = lenAt(3000);
    // Equal increments should be equal
    near(l2 - l1, l3 - l2, 1e-9);
    // And the increment should equal 1000 * 1e-5 = 0.01
    near(l2 - l1, 0.01, 1e-9);
  });

  it("preserves direction — same lat/lon points in same direction regardless of altitude", () => {
    const a = latLonAltToVec3(30, 40, 0);
    const b = latLonAltToVec3(30, 40, 5000);
    const aLen = Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z);
    const bLen = Math.sqrt(b.x * b.x + b.y * b.y + b.z * b.z);
    // Normalize and compare
    near(a.x / aLen, b.x / bLen, 1e-12);
    near(a.y / aLen, b.y / bLen, 1e-12);
    near(a.z / aLen, b.z / bLen, 1e-12);
  });
});

describe("greatCircleStep", () => {
  it("velocity=0 → position does not change", () => {
    const [lat, lon] = greatCircleStep(45, 10, 0, 90, 5);
    expect(lat).toBe(45);
    expect(lon).toBe(10);
  });

  it("dt<=0 → position does not change", () => {
    const [lat, lon] = greatCircleStep(45, 10, 250, 90, 0);
    expect(lat).toBe(45);
    expect(lon).toBe(10);

    const [lat2, lon2] = greatCircleStep(45, 10, 250, 90, -5);
    expect(lat2).toBe(45);
    expect(lon2).toBe(10);
  });

  it("heading=90 (east) on equator → lat unchanged, lon increases", () => {
    const velocity = 250; // m/s
    const dt = 10; // s
    const [newLat, newLon] = greatCircleStep(0, 0, velocity, 90, dt);
    // heading=90 ⇒ cos=0, so dLat should be 0
    near(newLat, 0, 1e-9);
    // Expected lon movement: (v * sin(90°) / R_EARTH_M) * dt * (180/π)
    const expectedDLon =
      ((velocity * 1) / R_EARTH_M) * dt * (180 / Math.PI);
    near(newLon, expectedDLon, 1e-9);
    expect(newLon).toBeGreaterThan(0);
  });

  it("heading=0 (north) → lon unchanged, lat increases", () => {
    const velocity = 250;
    const dt = 10;
    const [newLat, newLon] = greatCircleStep(0, 0, velocity, 0, dt);
    // sin(0)=0 ⇒ dLon=0
    near(newLon, 0, 1e-9);
    const expectedDLat = (velocity / R_EARTH_M) * dt * (180 / Math.PI);
    near(newLat, expectedDLat, 1e-9);
    expect(newLat).toBeGreaterThan(0);
  });

  it("heading=180 (south) → lat decreases", () => {
    const [newLat, newLon] = greatCircleStep(10, 0, 250, 180, 10);
    expect(newLat).toBeLessThan(10);
    near(newLon, 0, 1e-9);
  });

  it("heading=270 (west) → lon decreases", () => {
    const [newLat, newLon] = greatCircleStep(0, 0, 250, 270, 10);
    near(newLat, 0, 1e-9);
    expect(newLon).toBeLessThan(0);
  });

  it("heading wrap: 361 behaves similar to 1", () => {
    const a = greatCircleStep(0, 0, 250, 1, 10);
    const b = greatCircleStep(0, 0, 250, 361, 10);
    near(a[0], b[0], 1e-9);
    near(a[1], b[1], 1e-9);
  });

  it("longitude wraps from +180 to negative range", () => {
    // Start near eastern edge at equator going east → should wrap to -180..
    // We need a big step that pushes lon over 180.
    // 0.01 deg/s at v=250? actually at equator v=250 m/s for 10s → ~0.022 deg.
    // Pick starting lon just below 180 and a huge dt.
    const [_lat, newLon] = greatCircleStep(0, 179.99, 250, 90, 1000);
    // With big dt, lon should wrap to -180..180 range.
    expect(newLon).toBeLessThanOrEqual(180);
    expect(newLon).toBeGreaterThanOrEqual(-180);
    // And since we pushed east beyond 180, result must be negative (wrapped)
    expect(newLon).toBeLessThan(0);
  });

  it("longitude wraps from -180 to positive range", () => {
    const [_lat, newLon] = greatCircleStep(0, -179.99, 250, 270, 1000);
    expect(newLon).toBeLessThanOrEqual(180);
    expect(newLon).toBeGreaterThanOrEqual(-180);
    expect(newLon).toBeGreaterThan(0);
  });

  it("latitude clamps at +90", () => {
    // Huge dt going north to push past pole
    const [newLat] = greatCircleStep(80, 0, 500, 0, 100000);
    expect(newLat).toBeLessThanOrEqual(90);
    // Should be clamped exactly at 90
    expect(newLat).toBe(90);
  });

  it("latitude clamps at -90", () => {
    const [newLat] = greatCircleStep(-80, 0, 500, 180, 100000);
    expect(newLat).toBeGreaterThanOrEqual(-90);
    expect(newLat).toBe(-90);
  });

  it("near-pole longitude step does not explode (cosLat protection)", () => {
    // At exactly ±90° cos(lat)=0; the code guards with || 1e-6.
    const [newLat, newLon] = greatCircleStep(89.9999, 0, 250, 90, 1);
    // Should return finite numbers
    expect(Number.isFinite(newLat)).toBe(true);
    expect(Number.isFinite(newLon)).toBe(true);
  });
});
