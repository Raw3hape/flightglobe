import { Canvas } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import * as THREE from "three";
import { Earth } from "./scene/Earth";
import { Countries } from "./scene/Countries";
import { AircraftLayer } from "./scene/Aircraft";
import { Trails } from "./scene/Trails";
import { Status } from "./hud/Status";
import { useAircraftSocket } from "./net/useAircraftSocket";

export default function App() {
  useAircraftSocket();

  return (
    <div style={{ width: "100vw", height: "100vh", position: "relative" }}>
      <Canvas
        gl={{ antialias: true, toneMapping: THREE.NoToneMapping }}
        camera={{ position: [0, 0, 3], fov: 50, near: 0.01, far: 100 }}
        dpr={[1, 2]}
        style={{ background: "#04070d" }}
      >
        {/* Очень тёмный сине-серый фон (не чисто чёрный) */}
        <color attach="background" args={["#04070d"]} />
        <ambientLight intensity={0.15} />
        <Earth />
        <Countries />
        <Trails />
        <AircraftLayer />
        <OrbitControls
          enableDamping
          dampingFactor={0.08}
          rotateSpeed={0.5}
          zoomSpeed={0.8}
          minDistance={1.3}
          maxDistance={8}
          autoRotate={false}
        />
        {/* Post-processing намеренно удалён — больше не нужен bloom/glow. */}
      </Canvas>
      <Status />
    </div>
  );
}
