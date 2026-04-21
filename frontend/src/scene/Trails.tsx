import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { useStore } from "../state/store";
import type { TrackedAircraft } from "../state/store";
import { latLonAltToVec3 } from "../utils/geo";
import { altitudeToColor } from "../utils/color";

// Trails = настоящие соединённые линии (LineSegments).
// Между каждой парой hard-samples добавляем INTERMEDIATE точек по great-circle,
// чтобы линия была плавной и плотной. Линии 1px (ограничение WebGL),
// но при плотном сэмплинге читаются как непрерывная трасса.

const TRAIL_LEN = 150;        // 5 мин истории наблюдения
const SAMPLE_MS = 2000;
const INTERMEDIATE = 3;       // плотность кривой
const GPU_UPDATE_MS = 120;
const MAX_AIRCRAFT_TRAILS = 2000;
// Точек на самолёт: TRAIL_LEN + (TRAIL_LEN-1)*INTERMEDIATE
const POINTS_PER_AIRCRAFT = TRAIL_LEN + (TRAIL_LEN - 1) * INTERMEDIATE;
// Сегментов на самолёт = POINTS_PER_AIRCRAFT - 1
const SEGS_PER_AIRCRAFT = POINTS_PER_AIRCRAFT - 1;
// Vertex-слотов на самолёт = сегменты × 2 (start+end)
const VERTS_PER_AIRCRAFT = SEGS_PER_AIRCRAFT * 2;
const MAX_VERTS = MAX_AIRCRAFT_TRAILS * VERTS_PER_AIRCRAFT;

const OLD_COLOR = new THREE.Color("#8fa5c0");
const MIN_BRIGHT = 0.7;

type Ring = {
  samples: Float32Array;
  head: number;
  filled: number;
  lastSampleT: number;
};

function slerpLatLon(
  lat0: number, lon0: number, alt0: number,
  lat1: number, lon1: number, alt1: number,
  f: number,
  out: [number, number, number]
): void {
  const DEG = Math.PI / 180;
  const phi0 = lat0 * DEG;
  const phi1 = lat1 * DEG;
  const lam0 = lon0 * DEG;
  const lam1 = lon1 * DEG;
  const x0 = Math.cos(phi0) * Math.cos(lam0);
  const y0 = Math.cos(phi0) * Math.sin(lam0);
  const z0 = Math.sin(phi0);
  const x1 = Math.cos(phi1) * Math.cos(lam1);
  const y1 = Math.cos(phi1) * Math.sin(lam1);
  const z1 = Math.sin(phi1);
  let dot = x0 * x1 + y0 * y1 + z0 * z1;
  if (dot > 1) dot = 1;
  if (dot < -1) dot = -1;
  const omega = Math.acos(dot);
  if (omega < 1e-6) {
    out[0] = lat0 + (lat1 - lat0) * f;
    let dLon = lon1 - lon0;
    if (dLon > 180) dLon -= 360;
    else if (dLon < -180) dLon += 360;
    out[1] = lon0 + dLon * f;
    out[2] = alt0 + (alt1 - alt0) * f;
    return;
  }
  const s0 = Math.sin((1 - f) * omega) / Math.sin(omega);
  const s1 = Math.sin(f * omega) / Math.sin(omega);
  const x = s0 * x0 + s1 * x1;
  const y = s0 * y0 + s1 * y1;
  const z = s0 * z0 + s1 * z1;
  out[0] = Math.atan2(z, Math.sqrt(x * x + y * y)) / DEG;
  out[1] = Math.atan2(y, x) / DEG;
  out[2] = alt0 + (alt1 - alt0) * f;
}

export function Trails() {
  const aircraftMap = useStore((s) => s.aircraft);
  const ringsRef = useRef<Map<string, Ring>>(new Map());

  const positions = useMemo(() => new Float32Array(MAX_VERTS * 3), []);
  const colors = useMemo(() => new Float32Array(MAX_VERTS * 3), []);

  const posAttrRef = useRef<THREE.BufferAttribute>(null);
  const colAttrRef = useRef<THREE.BufferAttribute>(null);
  const geomRef = useRef<THREE.BufferGeometry>(null);

  const tmpVec = useMemo(() => new THREE.Vector3(), []);
  const tmpColor = useMemo(() => new THREE.Color(), []);
  const tmpLL = useMemo<[number, number, number]>(() => [0, 0, 0], []);
  const lastGpuUpdateRef = useRef<number>(0);

  // Pre-allocated scratch: все точки одного aircraft с pre-computed XYZ+brightness
  const scratchPts = useMemo(
    () => new Float32Array(POINTS_PER_AIRCRAFT * 4), // x,y,z,bright
    []
  );

  useEffect(() => {
    return () => {
      ringsRef.current.clear();
    };
  }, []);

  useFrame(() => {
    const geom = geomRef.current;
    const posAttr = posAttrRef.current;
    const colAttr = colAttrRef.current;
    if (!geom || !posAttr || !colAttr) return;

    const now = performance.now();
    const rings = ringsRef.current;

    // 1) Sample — hard point каждые SAMPLE_MS
    aircraftMap.forEach((a: TrackedAircraft) => {
      let ring = rings.get(a.id);
      if (!ring) {
        ring = {
          samples: new Float32Array(TRAIL_LEN * 3),
          head: 0,
          filled: 0,
          lastSampleT: 0,
        };
        // Pre-fill из server-provided истории, если она есть. Это избавляет
        // от необходимости ждать, пока клиент насемплит трейл своим SAMPLE_MS.
        // В hello сервер присылает до HISTORY_LEN (обычно 60) последних точек;
        // берём хвост, влезающий в наш TRAIL_LEN.
        if (a.initialHistory && a.initialHistory.length > 0) {
          const h = a.initialHistory;
          const startIdx = Math.max(0, h.length - TRAIL_LEN);
          for (let i = startIdx; i < h.length; i++) {
            const [lat, lon, alt] = h[i];
            const o = ring.head * 3;
            ring.samples[o] = lat;
            ring.samples[o + 1] = lon;
            ring.samples[o + 2] = alt;
            ring.head = (ring.head + 1) % TRAIL_LEN;
            if (ring.filled < TRAIL_LEN) ring.filled++;
          }
          // Сдвигаем "последний сэмпл" на now, чтобы не добавить дубликат
          // сразу после pre-fill: client sampling продолжится через SAMPLE_MS.
          ring.lastSampleT = now;
        }
        rings.set(a.id, ring);
      }
      if (now - ring.lastSampleT < SAMPLE_MS) return;
      ring.lastSampleT = now;
      const o = ring.head * 3;
      ring.samples[o] = a.prevRenderLat;
      ring.samples[o + 1] = a.prevRenderLon;
      ring.samples[o + 2] = a.altitude;
      ring.head = (ring.head + 1) % TRAIL_LEN;
      if (ring.filled < TRAIL_LEN) ring.filled++;
    });

    // 2) Cleanup orphaned rings
    if (rings.size > aircraftMap.size + 64) {
      const toDel: string[] = [];
      rings.forEach((_r, id) => {
        if (!aircraftMap.has(id)) toDel.push(id);
      });
      for (const id of toDel) rings.delete(id);
    }

    // 3) Throttle GPU update
    if (now - lastGpuUpdateRef.current < GPU_UPDATE_MS) return;
    lastGpuUpdateRef.current = now;

    let vi = 0;
    let aircraftEmitted = 0;

    aircraftMap.forEach((a: TrackedAircraft) => {
      if (aircraftEmitted >= MAX_AIRCRAFT_TRAILS) return;
      const ring = rings.get(a.id);
      if (!ring || ring.filled < 2) return;

      altitudeToColor(a.altitude, tmpColor);
      const hR = tmpColor.r;
      const hG = tmpColor.g;
      const hB = tmpColor.b;

      const startIdx = (ring.head - ring.filled + TRAIL_LEN) % TRAIL_LEN;
      const count = ring.filled;

      // Step 1: построить плотную последовательность точек (hard + intermediate)
      let ptCount = 0;
      for (let k = 0; k < count - 1; k++) {
        const idxA = (startIdx + k) % TRAIL_LEN;
        const idxB = (startIdx + k + 1) % TRAIL_LEN;
        const latA = ring.samples[idxA * 3];
        const lonA = ring.samples[idxA * 3 + 1];
        const altA = ring.samples[idxA * 3 + 2];
        const latB = ring.samples[idxB * 3];
        const lonB = ring.samples[idxB * 3 + 1];
        const altB = ring.samples[idxB * 3 + 2];

        for (let s = 0; s < INTERMEDIATE + 1; s++) {
          if (ptCount >= POINTS_PER_AIRCRAFT) break;
          const f = s / (INTERMEDIATE + 1);
          slerpLatLon(latA, lonA, altA, latB, lonB, altB, f, tmpLL);
          latLonAltToVec3(tmpLL[0], tmpLL[1], tmpLL[2], tmpVec);
          const bright = (k + f) / Math.max(1, count - 1);
          const po = ptCount * 4;
          scratchPts[po] = tmpVec.x;
          scratchPts[po + 1] = tmpVec.y;
          scratchPts[po + 2] = tmpVec.z;
          scratchPts[po + 3] = bright;
          ptCount++;
        }
      }
      // Последняя hard-точка
      if (ptCount < POINTS_PER_AIRCRAFT) {
        const idxL = (startIdx + count - 1) % TRAIL_LEN;
        const latL = ring.samples[idxL * 3];
        const lonL = ring.samples[idxL * 3 + 1];
        const altL = ring.samples[idxL * 3 + 2];
        latLonAltToVec3(latL, lonL, altL, tmpVec);
        const po = ptCount * 4;
        scratchPts[po] = tmpVec.x;
        scratchPts[po + 1] = tmpVec.y;
        scratchPts[po + 2] = tmpVec.z;
        scratchPts[po + 3] = 1.0;
        ptCount++;
      }

      // Step 2: эмитим pairs as LineSegments ([p0,p1], [p1,p2], [p2,p3], ...)
      for (let i = 0; i < ptCount - 1; i++) {
        if (vi + 2 > MAX_VERTS) break;
        const a0 = i * 4;
        const a1 = (i + 1) * 4;
        const b0 = MIN_BRIGHT + (1 - MIN_BRIGHT) * scratchPts[a0 + 3];
        const b1 = MIN_BRIGHT + (1 - MIN_BRIGHT) * scratchPts[a1 + 3];

        // start vertex
        positions[vi * 3 + 0] = scratchPts[a0];
        positions[vi * 3 + 1] = scratchPts[a0 + 1];
        positions[vi * 3 + 2] = scratchPts[a0 + 2];
        colors[vi * 3 + 0] = OLD_COLOR.r + (hR - OLD_COLOR.r) * b0;
        colors[vi * 3 + 1] = OLD_COLOR.g + (hG - OLD_COLOR.g) * b0;
        colors[vi * 3 + 2] = OLD_COLOR.b + (hB - OLD_COLOR.b) * b0;
        vi++;
        // end vertex
        positions[vi * 3 + 0] = scratchPts[a1];
        positions[vi * 3 + 1] = scratchPts[a1 + 1];
        positions[vi * 3 + 2] = scratchPts[a1 + 2];
        colors[vi * 3 + 0] = OLD_COLOR.r + (hR - OLD_COLOR.r) * b1;
        colors[vi * 3 + 1] = OLD_COLOR.g + (hG - OLD_COLOR.g) * b1;
        colors[vi * 3 + 2] = OLD_COLOR.b + (hB - OLD_COLOR.b) * b1;
        vi++;
      }

      aircraftEmitted++;
    });

    geom.setDrawRange(0, vi);
    posAttr.needsUpdate = true;
    colAttr.needsUpdate = true;
  });

  return (
    <lineSegments frustumCulled={false} renderOrder={2}>
      <bufferGeometry ref={geomRef}>
        <bufferAttribute
          ref={posAttrRef}
          attach="attributes-position"
          args={[positions, 3]}
          usage={THREE.DynamicDrawUsage}
        />
        <bufferAttribute
          ref={colAttrRef}
          attach="attributes-color"
          args={[colors, 3]}
          usage={THREE.DynamicDrawUsage}
        />
      </bufferGeometry>
      <lineBasicMaterial
        vertexColors
        transparent
        opacity={1.0}
        depthTest={false}
        depthWrite={false}
      />
    </lineSegments>
  );
}
