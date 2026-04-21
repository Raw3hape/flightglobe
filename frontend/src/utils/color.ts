import * as THREE from "three";

// Altitude → color (приглушённая палитра для data-viz, без неона).
// 0 m     → #ff9d5c (тёплый оранжевый)
// 12000 m → #7ec7ff (мягкий голубой)
//
// Интерполяция в линейном RGB (а не через HSL), чтобы гарантированно:
//   - r падает с высотой (#ff9d5c r=1.0 → #7ec7ff r≈0.494)
//   - b растёт с высотой (#ff9d5c b≈0.360 → #7ec7ff b≈1.0)
const LOW = new THREE.Color("#ff9d5c");
const HIGH = new THREE.Color("#7ec7ff");

export function altitudeToColor(altM: number, out?: THREE.Color): THREE.Color {
  const c = out ?? new THREE.Color();
  let t = altM / 12000;
  if (t < 0) t = 0;
  if (t > 1) t = 1;
  c.r = LOW.r + (HIGH.r - LOW.r) * t;
  c.g = LOW.g + (HIGH.g - LOW.g) * t;
  c.b = LOW.b + (HIGH.b - LOW.b) * t;
  return c;
}
