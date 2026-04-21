import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { altitudeToColor } from "./color";

function getRGB(c: THREE.Color) {
  return { r: c.r, g: c.g, b: c.b };
}

describe("altitudeToColor", () => {
  it("altitude=0 → тёплый оранжевый (#ff9d5c)", () => {
    const expected = new THREE.Color("#ff9d5c");
    const c = altitudeToColor(0);
    const a = getRGB(c);
    const e = getRGB(expected);
    expect(Math.abs(a.r - e.r)).toBeLessThan(1e-3);
    expect(Math.abs(a.g - e.g)).toBeLessThan(1e-3);
    expect(Math.abs(a.b - e.b)).toBeLessThan(1e-3);
  });

  it("altitude=12000 → мягкий голубой (#7ec7ff)", () => {
    const expected = new THREE.Color("#7ec7ff");
    const c = altitudeToColor(12000);
    const a = getRGB(c);
    const e = getRGB(expected);
    expect(Math.abs(a.r - e.r)).toBeLessThan(1e-3);
    expect(Math.abs(a.g - e.g)).toBeLessThan(1e-3);
    expect(Math.abs(a.b - e.b)).toBeLessThan(1e-3);
  });

  it("altitude=6000 → distinct from both extremes (not equal to low or high)", () => {
    const low = altitudeToColor(0).clone();
    const mid = altitudeToColor(6000).clone();
    const high = altitudeToColor(12000).clone();
    const differs = (a: THREE.Color, b: THREE.Color) =>
      Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b) > 1e-6;
    expect(differs(mid, low)).toBe(true);
    expect(differs(mid, high)).toBe(true);
  });

  it("altitude below 0 is clamped to 0 (same color as at 0)", () => {
    const a = altitudeToColor(-5000);
    const b = altitudeToColor(0);
    expect(a.r).toBeCloseTo(b.r, 10);
    expect(a.g).toBeCloseTo(b.g, 10);
    expect(a.b).toBeCloseTo(b.b, 10);
  });

  it("altitude above 12000 is clamped to 12000", () => {
    const a = altitudeToColor(20000);
    const b = altitudeToColor(12000);
    expect(a.r).toBeCloseTo(b.r, 10);
    expect(a.g).toBeCloseTo(b.g, 10);
    expect(a.b).toBeCloseTo(b.b, 10);
  });

  it("monotonic on red (falls) and blue (rises) with altitude", () => {
    // Ключевое свойство шкалы: "низкие" самолёты теплее, "высокие" — холоднее.
    // Red должен монотонно падать, blue — монотонно расти.
    const alts = [0, 2000, 4000, 6000, 8000, 10000, 12000];
    const cols = alts.map((a) => altitudeToColor(a).clone());
    for (let i = 1; i < cols.length; i++) {
      expect(cols[i].r).toBeLessThanOrEqual(cols[i - 1].r + 1e-9);
    }
    for (let i = 1; i < cols.length; i++) {
      expect(cols[i].b).toBeGreaterThanOrEqual(cols[i - 1].b - 1e-9);
    }
  });

  it("writes into provided 'out' color instead of allocating", () => {
    const out = new THREE.Color(0, 0, 0);
    const ret = altitudeToColor(6000, out);
    expect(ret).toBe(out);
    expect(out.r + out.g + out.b).toBeGreaterThan(0);
  });
});
