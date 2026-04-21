import { useMemo } from "react";
import * as THREE from "three";

// Чистый data-viz стиль: приглушённый grid + очень мягкий fresnel halo,
// сплошная сфера-occluder для корректной работы depth-теста.

function buildLatLonGrid(
  radius: number,
  latStepDeg = 15,
  lonStepDeg = 15,
  segPerCircle = 128
): THREE.BufferGeometry {
  const positions: number[] = [];

  // Параллели (широтные круги)
  for (let lat = -75; lat <= 75; lat += latStepDeg) {
    const phi = (90 - lat) * (Math.PI / 180);
    const r = radius * Math.sin(phi);
    const y = radius * Math.cos(phi);
    for (let i = 0; i < segPerCircle; i++) {
      const t0 = (i / segPerCircle) * Math.PI * 2;
      const t1 = ((i + 1) / segPerCircle) * Math.PI * 2;
      positions.push(
        -r * Math.cos(t0),
        y,
        r * Math.sin(t0),
        -r * Math.cos(t1),
        y,
        r * Math.sin(t1)
      );
    }
  }

  // Меридианы (полукруги полюс-к-полюсу)
  for (let lon = -180; lon < 180; lon += lonStepDeg) {
    const theta = (lon + 180) * (Math.PI / 180);
    for (let i = 0; i < segPerCircle; i++) {
      const a0 = (i / segPerCircle) * Math.PI;
      const a1 = ((i + 1) / segPerCircle) * Math.PI;
      const r0 = radius * Math.sin(a0);
      const y0 = radius * Math.cos(a0);
      const r1 = radius * Math.sin(a1);
      const y1 = radius * Math.cos(a1);
      positions.push(
        -r0 * Math.cos(theta),
        y0,
        r0 * Math.sin(theta),
        -r1 * Math.cos(theta),
        y1,
        r1 * Math.sin(theta)
      );
    }
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(positions, 3)
  );
  return g;
}

const FRESNEL_VS = /* glsl */ `
  varying vec3 vNormal;
  varying vec3 vViewDir;
  void main() {
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    vNormal = normalize(normalMatrix * normal);
    vViewDir = normalize(-mvPosition.xyz);
    gl_Position = projectionMatrix * mvPosition;
  }
`;

const FRESNEL_FS = /* glsl */ `
  varying vec3 vNormal;
  varying vec3 vViewDir;
  uniform vec3 uColor;
  uniform float uPower;
  uniform float uIntensity;
  void main() {
    float rim = 1.0 - max(dot(vNormal, vViewDir), 0.0);
    float f = pow(rim, uPower) * uIntensity;
    gl_FragColor = vec4(uColor * f, f);
  }
`;

export function Earth() {
  const gridGeom = useMemo(() => buildLatLonGrid(1.0015, 15, 15, 96), []);
  const gridMat = useMemo(
    () =>
      new THREE.LineBasicMaterial({
        color: new THREE.Color("#2a4560"),
        transparent: true,
        opacity: 0.1,
        depthWrite: false,
        blending: THREE.NormalBlending,
      }),
    []
  );

  const fresnelMat = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: FRESNEL_VS,
        fragmentShader: FRESNEL_FS,
        uniforms: {
          uColor: { value: new THREE.Color("#1a3a6a") },
          uPower: { value: 4.8 },
          uIntensity: { value: 0.22 },
        },
        transparent: true,
        side: THREE.BackSide,
        depthWrite: false,
        blending: THREE.NormalBlending,
      }),
    []
  );

  return (
    <group>
      {/* Сплошная сфера-occluder — прячет обратную сторону планеты */}
      <mesh renderOrder={-1}>
        <sphereGeometry args={[1.0, 128, 128]} />
        <meshBasicMaterial color={"#0a1422"} depthWrite={true} />
      </mesh>

      {/* Приглушённый lat/lon грид */}
      <lineSegments
        geometry={gridGeom}
        material={gridMat}
        renderOrder={0}
      />

      {/* Мягкий fresnel ободок */}
      <mesh scale={[1.03, 1.03, 1.03]} renderOrder={4}>
        <sphereGeometry args={[1.0, 64, 64]} />
        <primitive object={fresnelMat} attach="material" />
      </mesh>
    </group>
  );
}
