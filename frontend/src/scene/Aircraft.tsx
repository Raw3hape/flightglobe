import { useEffect, useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { useStore } from "../state/store";
import type { TrackedAircraft } from "../state/store";
import { greatCircleStep } from "../utils/geo";
import { altitudeToColor } from "../utils/color";

export const MAX_INSTANCES = 20000;
const SPAWN_MS = 800;
const DESPAWN_MS = 2500;
const STALE_MS = 45000;
const SMOOTH_TAU = 0.35; // sec — экспоненциальное сглаживание движения

const DEG = Math.PI / 180;

// Треугольная стрелка-самолёт: нос вверх (+Y local), крылья вниз.
// Координаты — «единичный» локальный frame; реальный размер в пикселях
// задаётся через instanceSize + uViewport в вершинном шейдере.
const TRI_POSITIONS = new Float32Array([
  0.0,  1.0, 0.0,   // нос
  -0.7, -0.8, 0.0,  // левое крыло
  0.7, -0.8, 0.0,   // правое крыло
]);
// UV не используем, но WebGL иногда требует его — оставим корректный.
const TRI_UVS = new Float32Array([0.5, 1.0, 0.0, 0.0, 1.0, 0.0]);

// Vertex shader: screen-space размер + поворот по heading через проекцию
// forward-точки (aircraft_world + forward_world) в NDC.
const TRI_VS = /* glsl */ `
  attribute vec3 instanceColor;
  attribute float instanceAlpha;
  attribute float instanceSize;     // pixels (CSS)
  attribute vec3 instanceForward;   // unit tangent vector along heading (world)

  uniform vec2 uViewport;           // canvas CSS size in pixels

  varying vec3 vColor;
  varying float vAlpha;

  void main() {
    vColor = instanceColor;
    vAlpha = instanceAlpha;

    // Позиция самолёта в мире: instanceMatrix * (0,0,0)
    vec4 aircraftWorld = instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);

    // Точка «вперёд» в мире — не зависит от scale/rotation instanceMatrix
    vec4 forwardWorld = aircraftWorld + vec4(instanceForward, 0.0);

    vec4 centerClip  = projectionMatrix * modelViewMatrix * aircraftWorld;
    vec4 forwardClip = projectionMatrix * modelViewMatrix * forwardWorld;

    // NDC
    vec2 centerNDC  = centerClip.xy  / centerClip.w;
    vec2 forwardNDC = forwardClip.xy / forwardClip.w;

    // Экранное направление «вперёд» (и перпендикуляр — вправо от него)
    vec2 d = forwardNDC - centerNDC;
    float dLen = length(d);
    vec2 dir  = dLen > 1e-6 ? d / dLen : vec2(0.0, 1.0);
    vec2 perp = vec2(-dir.y, dir.x);

    // Локальная позиция вершины треугольника:
    //   position.y — вдоль «вперёд»
    //   position.x — вбок
    vec2 screenOffset = position.x * perp + position.y * dir;

    // Перевод пикселей в NDC (с учётом размера viewport)
    vec2 offsetNDC = screenOffset * instanceSize * 2.0 / uViewport;

    vec4 finalClip = centerClip;
    finalClip.xy = (centerNDC + offsetNDC) * centerClip.w;
    gl_Position = finalClip;
  }
`;

// Fragment shader: сплошной цвет без радиального glow — треугольник
// сам даёт форму. MSAA из Canvas antialias:true даёт чистую кромку.
const TRI_FS = /* glsl */ `
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    if (vAlpha <= 0.001) discard;
    gl_FragColor = vec4(vColor, vAlpha);
  }
`;

export function AircraftLayer() {
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const aircraftMap = useStore((s) => s.aircraft);
  const removeExpired = useStore((s) => s.removeExpired);
  const markDespawned = useStore((s) => s.markDespawned);

  const { size } = useThree();

  // Per-instance данные
  const colorArr   = useMemo(() => new Float32Array(MAX_INSTANCES * 3), []);
  const alphaArr   = useMemo(() => new Float32Array(MAX_INSTANCES), []);
  const sizeArr    = useMemo(() => new Float32Array(MAX_INSTANCES), []);
  const forwardArr = useMemo(() => new Float32Array(MAX_INSTANCES * 3), []);

  const uViewport = useMemo(
    () => ({ value: new THREE.Vector2(size.width, size.height) }),
    [] // init only; обновляем в useFrame
  );

  const geometry = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(TRI_POSITIONS, 3));
    g.setAttribute("uv", new THREE.BufferAttribute(TRI_UVS, 2));

    const colorAttr   = new THREE.InstancedBufferAttribute(colorArr, 3);
    const alphaAttr   = new THREE.InstancedBufferAttribute(alphaArr, 1);
    const sizeAttr    = new THREE.InstancedBufferAttribute(sizeArr, 1);
    const forwardAttr = new THREE.InstancedBufferAttribute(forwardArr, 3);
    colorAttr.setUsage(THREE.DynamicDrawUsage);
    alphaAttr.setUsage(THREE.DynamicDrawUsage);
    sizeAttr.setUsage(THREE.DynamicDrawUsage);
    forwardAttr.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute("instanceColor", colorAttr);
    g.setAttribute("instanceAlpha", alphaAttr);
    g.setAttribute("instanceSize", sizeAttr);
    g.setAttribute("instanceForward", forwardAttr);
    return g;
  }, [colorArr, alphaArr, sizeArr, forwardArr]);

  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: TRI_VS,
        fragmentShader: TRI_FS,
        uniforms: { uViewport },
        transparent: true,
        depthWrite: false,
        blending: THREE.NormalBlending,
        side: THREE.DoubleSide,
      }),
    [uViewport]
  );

  const tmpObj = useMemo(() => new THREE.Object3D(), []);
  const tmpColor = useMemo(() => new THREE.Color(), []);
  const prevFrameTimeRef = useRef<number>(performance.now());

  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  }, []);

  useFrame(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    const now = performance.now();

    // viewport uniform — обновляем каждый кадр (дёшево, реагирует на resize)
    uViewport.value.set(size.width, size.height);

    const prev = prevFrameTimeRef.current;
    const dt = Math.max(0, Math.min(0.1, (now - prev) / 1000));
    prevFrameTimeRef.current = now;
    const k = 1 - Math.exp(-dt / SMOOTH_TAU);

    let i = 0;
    const expired: string[] = [];
    const stale: string[] = [];

    aircraftMap.forEach((a: TrackedAircraft) => {
      if (i >= MAX_INSTANCES) return;

      if (a.despawnAt == null && now - a.lastServerAt > STALE_MS) {
        stale.push(a.id);
      }
      if (a.despawnAt != null && now - a.despawnAt > DESPAWN_MS) {
        expired.push(a.id);
        return;
      }

      // Dead-reckoning цель
      const dtSec = (now - a.baseT) / 1000;
      const [targetLat, targetLon] = greatCircleStep(
        a.baseLat,
        a.baseLon,
        a.velocity,
        a.heading,
        dtSec
      );

      // Эксп. сглаживание
      a.prevRenderLat = a.prevRenderLat + (targetLat - a.prevRenderLat) * k;
      let dLon = targetLon - a.prevRenderLon;
      if (dLon > 180) dLon -= 360;
      else if (dLon < -180) dLon += 360;
      a.prevRenderLon = a.prevRenderLon + dLon * k;
      if (a.prevRenderLon > 180) a.prevRenderLon -= 360;
      else if (a.prevRenderLon < -180) a.prevRenderLon += 360;

      // Позиция на сфере: r = 1 + small alt lift
      const phi = a.prevRenderLat * DEG;
      const lam = a.prevRenderLon * DEG;
      const r = 1.005 + Math.min(a.altitude, 15000) * 1e-5;
      const cp = Math.cos(phi);
      const sp = Math.sin(phi);
      const cl = Math.cos(lam);
      const sl = Math.sin(lam);
      const px = r * cp * cl;
      const py = r * sp;
      const pz = r * cp * sl;

      // Касательный frame: north (d/dphi), east unit = (-sin(lam), 0, cos(lam))
      const nx = -sp * cl;
      const ny = cp;
      const nz = -sp * sl;
      const ex = -sl;
      const ez = cl;

      // Heading: 0° = север, 90° = восток (стандарт)
      const hr = a.heading * DEG;
      const ch = Math.cos(hr);
      const sh = Math.sin(hr);
      // forward = cos(h) * north + sin(h) * east
      const fx = ch * nx + sh * ex;
      const fy = ch * ny; // sh * 0
      const fz = ch * nz + sh * ez;

      // Lifecycle alpha
      let alpha = 1;
      const sinceSpawn = now - a.spawnedAt;
      if (sinceSpawn < SPAWN_MS) {
        const kS = sinceSpawn / SPAWN_MS;
        alpha = 1 - (1 - kS) * (1 - kS);
      }
      if (a.despawnAt != null) {
        const kD = (now - a.despawnAt) / DESPAWN_MS;
        alpha = Math.min(alpha, Math.max(0, 1 - kD));
      }

      // Размер в CSS пикселях — постоянный независимо от zoom.
      // Достаточно маленький чтоб не сливаться в кластерах (avia-трассы).
      const pxSize = 4.5 + Math.min(a.altitude / 12000, 1) * 1.5;

      // instanceMatrix: только translation (scale=1, rotation=identity)
      tmpObj.position.set(px, py, pz);
      tmpObj.rotation.set(0, 0, 0);
      tmpObj.scale.setScalar(1);
      tmpObj.updateMatrix();
      mesh.setMatrixAt(i, tmpObj.matrix);

      altitudeToColor(a.altitude, tmpColor);
      colorArr[i * 3 + 0] = tmpColor.r;
      colorArr[i * 3 + 1] = tmpColor.g;
      colorArr[i * 3 + 2] = tmpColor.b;
      alphaArr[i] = alpha;
      sizeArr[i] = pxSize;
      forwardArr[i * 3 + 0] = fx;
      forwardArr[i * 3 + 1] = fy;
      forwardArr[i * 3 + 2] = fz;

      i++;
    });

    mesh.count = i;
    mesh.instanceMatrix.needsUpdate = true;
    (geometry.getAttribute("instanceColor") as THREE.InstancedBufferAttribute).needsUpdate = true;
    (geometry.getAttribute("instanceAlpha") as THREE.InstancedBufferAttribute).needsUpdate = true;
    (geometry.getAttribute("instanceSize") as THREE.InstancedBufferAttribute).needsUpdate = true;
    (geometry.getAttribute("instanceForward") as THREE.InstancedBufferAttribute).needsUpdate = true;

    if (stale.length) markDespawned(stale);
    if (expired.length) removeExpired(expired);
  });

  return (
    <instancedMesh
      ref={meshRef}
      // @ts-ignore
      args={[geometry, material, MAX_INSTANCES]}
      frustumCulled={false}
      renderOrder={3}
    />
  );
}
