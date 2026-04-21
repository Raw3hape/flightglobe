import { useEffect, useMemo, useState } from "react";
import * as THREE from "three";
// topojson-client types are loose; treat as any to avoid TS friction.
// @ts-ignore
import * as topojson from "topojson-client";
import { latLonToVec3 } from "../utils/geo";

const TOPO_URL = "https://unpkg.com/world-atlas@2/land-110m.json";

// Обходим GeoJSON feature/geometry и эмитим [lon,lat] как line segments.
function collectSegments(geom: any, out: number[], surfaceR: number) {
  if (!geom) return;
  const type = geom.type;
  const coords = geom.coordinates;
  if (type === "Polygon") {
    for (const ring of coords) ringToSegments(ring, out, surfaceR);
  } else if (type === "MultiPolygon") {
    for (const poly of coords) {
      for (const ring of poly) ringToSegments(ring, out, surfaceR);
    }
  } else if (type === "LineString") {
    ringToSegments(coords, out, surfaceR);
  } else if (type === "MultiLineString") {
    for (const line of coords) ringToSegments(line, out, surfaceR);
  } else if (type === "GeometryCollection") {
    for (const g of geom.geometries) collectSegments(g, out, surfaceR);
  }
}

function ringToSegments(ring: number[][], out: number[], surfaceR: number) {
  if (!ring || ring.length < 2) return;
  const v = new THREE.Vector3();
  for (let i = 0; i < ring.length - 1; i++) {
    const [lon0, lat0] = ring[i];
    const [lon1, lat1] = ring[i + 1];
    latLonToVec3(lat0, lon0, surfaceR, v);
    out.push(v.x, v.y, v.z);
    latLonToVec3(lat1, lon1, surfaceR, v);
    out.push(v.x, v.y, v.z);
  }
}

export function Countries() {
  const [positions, setPositions] = useState<Float32Array | null>(null);

  useEffect(() => {
    let aborted = false;
    (async () => {
      try {
        const res = await fetch(TOPO_URL);
        const topo: any = await res.json();
        const name = topo?.objects?.land ? "land" : "countries";
        const fc: any = topojson.feature(topo, topo.objects[name]);
        const arr: number[] = [];
        // Повыше grid (который на r=1.0)
        const r = 1.003;
        if (fc?.type === "FeatureCollection") {
          for (const f of fc.features) collectSegments(f.geometry, arr, r);
        } else if (fc?.type === "Feature") {
          collectSegments(fc.geometry, arr, r);
        } else if (fc?.type) {
          collectSegments(fc, arr, r);
        }
        if (!aborted) setPositions(new Float32Array(arr));
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn("Countries load failed:", e);
      }
    })();
    return () => {
      aborted = true;
    };
  }, []);

  const geometry = useMemo(() => {
    if (!positions) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    return g;
  }, [positions]);

  const material = useMemo(
    () =>
      new THREE.LineBasicMaterial({
        // Приглушённый серо-голубой вместо неона
        color: new THREE.Color("#5b8ca0"),
        transparent: true,
        opacity: 0.75,
        depthWrite: false,
        depthTest: true,
        blending: THREE.NormalBlending,
      }),
    []
  );

  if (!geometry) return null;
  return (
    <lineSegments
      geometry={geometry}
      material={material}
      renderOrder={1}
    />
  );
}
