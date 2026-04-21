import * as THREE from "three";

// Earth radius in meters (mean)
export const R_EARTH_M = 6371000;

// Globe base radius in scene units
export const GLOBE_RADIUS = 1.0;

// Convert lat/lon (degrees) + altitude (meters) → Vec3 on unit-sphere scale.
// r = 1.003 + altitude_m * 1e-5
export function latLonAltToVec3(
  lat: number,
  lon: number,
  altitudeM: number,
  out?: THREE.Vector3
): THREE.Vector3 {
  const v = out ?? new THREE.Vector3();
  const r = GLOBE_RADIUS + 0.003 + altitudeM * 1e-5;
  const phi = (90 - lat) * (Math.PI / 180);
  const theta = (lon + 180) * (Math.PI / 180);
  v.x = -r * Math.sin(phi) * Math.cos(theta);
  v.z = r * Math.sin(phi) * Math.sin(theta);
  v.y = r * Math.cos(phi);
  return v;
}

// Surface version (no altitude) — used for countries / grid
export function latLonToVec3(
  lat: number,
  lon: number,
  radius: number = GLOBE_RADIUS,
  out?: THREE.Vector3
): THREE.Vector3 {
  const v = out ?? new THREE.Vector3();
  const phi = (90 - lat) * (Math.PI / 180);
  const theta = (lon + 180) * (Math.PI / 180);
  v.x = -radius * Math.sin(phi) * Math.cos(theta);
  v.z = radius * Math.sin(phi) * Math.sin(theta);
  v.y = radius * Math.cos(phi);
  return v;
}

// Great-circle dead reckoning step.
// Given current lat/lon (deg), velocity (m/s), heading (deg, true), dt (sec),
// returns new [lat, lon] in degrees.
export function greatCircleStep(
  lat: number,
  lon: number,
  velocity: number,
  heading: number,
  dtSec: number
): [number, number] {
  if (!velocity || dtSec <= 0) return [lat, lon];
  const latRad = (lat * Math.PI) / 180;
  const hdgRad = (heading * Math.PI) / 180;
  const cosLat = Math.cos(latRad) || 1e-6;
  const dLatDeg =
    ((velocity * Math.cos(hdgRad)) / R_EARTH_M) * dtSec * (180 / Math.PI);
  const dLonDeg =
    ((velocity * Math.sin(hdgRad)) / (R_EARTH_M * cosLat)) *
    dtSec *
    (180 / Math.PI);
  let newLat = lat + dLatDeg;
  let newLon = lon + dLonDeg;
  // wrap lon to [-180..180]
  if (newLon > 180) newLon -= 360;
  if (newLon < -180) newLon += 360;
  // clamp lat
  if (newLat > 90) newLat = 90;
  if (newLat < -90) newLat = -90;
  return [newLat, newLon];
}
