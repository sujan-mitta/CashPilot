"use client";

import React, { useMemo, useRef } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import {
  TERRAIN,
  createPointerScratch,
  pointerToTerrainUV,
} from "./terrainPointer";

/**
 * The runway terrain.
 *
 * A deformed plane where height is cash and the two horizontal axes are time
 * and scenario. The flat translucent sheet cutting through it is the liquidity
 * safety floor; terrain below that sheet is a deficit and is lit rose, terrain
 * above it is lit emerald. That is the same claim the engine makes, drawn.
 *
 * Everything is done in the vertex/fragment shaders — the geometry is uploaded
 * once and never touched again, so animating it costs no CPU and allocates
 * nothing per frame. The only per-frame work is advancing a few uniforms.
 *
 * POINTER: the canvas is deliberately NOT interactive. It sits behind the login
 * form under `pointer-events: none`, so letting it capture events would put an
 * invisible sheet of glass over the inputs. Instead the pointer is tracked at
 * the window and the ray is intersected with the terrain's mathematical plane —
 * O(1), and it ignores pointer-events entirely. Raycasting the real geometry
 * would mean testing ~50k triangles every frame for a decorative effect.
 */

const vertexShader = /* glsl */ `
  uniform float uTime;
  uniform float uAmplitude;
  uniform vec2  uPointer;    // terrain UV under the cursor
  uniform float uHover;      // 0 → 1, eased

  varying float vHeight;
  varying vec2  vUv;
  varying float vRipple;

  // Layered sines rather than true noise: cheaper, and the repetition reads as
  // a plausible recurring cash cycle rather than as random terrain.
  float surface(vec2 p, float t) {
    float h = 0.0;
    h += sin(p.x * 1.6 + t * 0.55) * 0.55;
    h += sin(p.y * 1.3 - t * 0.4) * 0.42;
    h += sin((p.x + p.y) * 0.9 + t * 0.28) * 0.32;
    h += sin(p.x * 3.1 - p.y * 2.2 + t * 0.7) * 0.16;
    return h;
  }

  void main() {
    vUv = uv;

    vec3 pos = position;
    float h = surface(pos.xy, uTime) * uAmplitude;

    // Settle the terrain toward the safety plane at the far edge, so the
    // horizon reads as resolved rather than as noise running off the screen.
    float horizon = smoothstep(0.0, 0.65, vUv.y);
    h *= mix(1.0, 0.25, horizon);

    // ── Cursor ripple ──────────────────────────────────────────────────
    // Corrected for the plane's 16:11 aspect, or the rings read as ellipses.
    vec2 d2 = (vUv - uPointer) * vec2(16.0 / 11.0, 1.0);
    float d = length(d2);

    // Rings travelling outward from the cursor, decaying with distance so the
    // disturbance stays local and the rest of the surface keeps its own rhythm.
    float rings = sin(d * 38.0 - uTime * 3.4) * exp(-d * 6.5);

    // A broad swell under the cursor: the surface leans up toward the pointer.
    float swell = exp(-d * d * 26.0);

    float ripple = (rings * 0.26 + swell * 0.34) * uHover;
    h += ripple;
    vRipple = ripple;

    pos.z += h;
    vHeight = h;

    gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  uniform vec3  uSafeColor;
  uniform vec3  uRiskColor;
  uniform vec3  uGridColor;
  uniform vec3  uHoverColor;
  uniform float uFloor;
  uniform vec2  uPointer;
  uniform float uHover;

  varying float vHeight;
  varying vec2  vUv;
  varying float vRipple;

  void main() {
    // Below the safety floor is a deficit. The transition is deliberately
    // narrow — an operator should be able to see exactly where solvency ends.
    float deficit = 1.0 - smoothstep(uFloor - 0.06, uFloor + 0.06, vHeight);
    vec3 base = mix(uSafeColor, uRiskColor, deficit);

    // Instrument grid, drawn in UV space so line weight stays constant with
    // distance instead of aliasing into moire at the horizon.
    vec2 g = abs(fract(vUv * vec2(46.0, 30.0)) - 0.5) / fwidth(vUv * vec2(46.0, 30.0));
    float line = 1.0 - min(min(g.x, g.y), 1.0);

    // Height also drives brightness, so peaks read as "more cash" at a glance.
    float lift = smoothstep(-0.9, 1.1, vHeight);
    vec3 color = mix(uGridColor, base, 0.35 + lift * 0.65);

    // Fade at the far edge and at the left/right margins so the plane dissolves
    // into the page instead of ending on a hard rectangle.
    float fadeY = 1.0 - smoothstep(0.45, 1.0, vUv.y);
    float fadeX = smoothstep(0.0, 0.16, vUv.x) * (1.0 - smoothstep(0.84, 1.0, vUv.x));
    float alpha = line * fadeY * fadeX;

    // Deficit regions stay visible even between grid lines — the one thing on
    // this surface that must not be subtle.
    alpha = max(alpha, deficit * 0.16 * fadeY * fadeX);

    // ── Cursor light ───────────────────────────────────────────────────
    vec2 d2 = (vUv - uPointer) * vec2(16.0 / 11.0, 1.0);
    float halo = exp(-length(d2) * 5.0) * uHover;

    // Crests of the ripple catch the light; troughs stay dark. Without this the
    // halo is a flat disc rather than something washing over a surface.
    float crest = clamp(vRipple * 3.2, 0.0, 1.0);

    color += uHoverColor * (halo * 0.45 + crest * 0.5);
    alpha = max(alpha, (halo * 0.2 + crest * 0.28) * fadeY * fadeX);

    if (alpha < 0.004) discard;
    gl_FragColor = vec4(color, clamp(alpha, 0.0, 1.0));
  }
`;

function Terrain({
  amplitude = 1,
  pointer,
}: {
  amplitude?: number;
  pointer: React.RefObject<{ x: number; y: number; inside: boolean }>;
}) {
  const mesh = useRef<THREE.Mesh>(null);
  const material = useRef<THREE.ShaderMaterial>(null);
  const { camera } = useThree();

  // Allocated once. Doing this inside useFrame would allocate every frame.
  const scratch = useMemo(() => createPointerScratch(), []);

  const uniforms = useMemo(
    () => ({
      uTime: { value: 0 },
      uAmplitude: { value: amplitude },
      uFloor: { value: -0.15 },
      uHover: { value: 0 },
      // Parked off-surface so the very first frame cannot flash a ripple at
      // the centre before the pointer has ever been seen.
      uPointer: { value: new THREE.Vector2(-1, -1) },
      uSafeColor: { value: new THREE.Color("#34d399") },
      uRiskColor: { value: new THREE.Color("#fb7185") },
      uGridColor: { value: new THREE.Color("#4f46e5") },
      uHoverColor: { value: new THREE.Color("#22d3ee") },
    }),
    [amplitude]
  );

  useFrame((_, delta) => {
    const mat = material.current;
    const obj = mesh.current;
    if (!mat || !obj) return;

    // Advance by delta rather than elapsed time so a dropped frame slows the
    // motion instead of making it jump.
    mat.uniforms.uTime.value += delta;

    const p = pointer.current;
    let onSurface = false;

    if (p?.inside) {
      const uvHit = pointerToTerrainUV(p.x, p.y, camera, obj, scratch);
      if (uvHit) {
        mat.uniforms.uPointer.value.set(uvHit.u, uvHit.v);
        onSurface = true;
      }
    }

    // Ease the hover strength rather than switching it. A ripple that vanishes
    // the instant the cursor leaves looks broken; one that recedes looks like
    // water settling. Framerate-independent so it feels the same at 30 and 120.
    const target = onSurface ? 1 : 0;
    const rate = 1 - Math.exp(-delta * (onSurface ? 6 : 3));
    mat.uniforms.uHover.value += (target - mat.uniforms.uHover.value) * rate;
  });

  return (
    <mesh ref={mesh} rotation={[TERRAIN.rotationX, 0, 0]} position={[0, TERRAIN.y, 0]}>
      <planeGeometry args={[TERRAIN.width, TERRAIN.height, 190, 130]} />
      <shaderMaterial
        ref={material}
        uniforms={uniforms}
        vertexShader={vertexShader}
        fragmentShader={fragmentShader}
        transparent
        depthWrite={false}
        blending={THREE.AdditiveBlending}
        side={THREE.DoubleSide}
      />
    </mesh>
  );
}

/** The liquidity safety floor, as a physical sheet the terrain cuts through. */
function SafetyPlane() {
  return (
    <mesh rotation={[TERRAIN.rotationX, 0, 0]} position={[0, TERRAIN.y - 0.15, 0.001]}>
      <planeGeometry args={[TERRAIN.width, TERRAIN.height]} />
      <meshBasicMaterial
        color="#6366f1"
        transparent
        opacity={0.05}
        depthWrite={false}
        side={THREE.DoubleSide}
      />
    </mesh>
  );
}

/**
 * Camera drift.
 *
 * A slow figure-eight plus a weak pull toward the pointer. The drift is small
 * on purpose: this sits behind headline copy, and a camera that moves enough to
 * notice is a camera that makes text hard to read.
 */
function Rig({ pointer }: { pointer: React.RefObject<{ x: number; y: number }> }) {
  useFrame((state, delta) => {
    const t = state.clock.elapsedTime;
    const p = pointer.current ?? { x: 0, y: 0 };

    const targetX = Math.sin(t * 0.11) * 0.55 + p.x * 0.5;
    const targetY = 2.4 + Math.sin(t * 0.16) * 0.16 + p.y * 0.3;

    const rate = 1 - Math.exp(-delta * 1.6);
    state.camera.position.x += (targetX - state.camera.position.x) * rate;
    state.camera.position.y += (targetY - state.camera.position.y) * rate;
    state.camera.lookAt(0, -0.5, -1.2);
  });
  return null;
}

export default function RunwayTerrain({ className }: { className?: string }) {
  const host = useRef<HTMLDivElement>(null);
  // Normalised device coordinates (-1 … 1), plus whether the cursor is over
  // the hero region at all.
  const pointer = useRef({ x: 0, y: 0, inside: false });

  // Tracked on the window rather than on the canvas. The hero sits under
  // `pointer-events: none` so it never steals a click from the sign-in form,
  // which also means it can never receive a pointer event of its own.
  React.useEffect(() => {
    const onMove = (event: PointerEvent) => {
      const el = host.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) return;

      const x = ((event.clientX - r.left) / r.width) * 2 - 1;
      const y = -(((event.clientY - r.top) / r.height) * 2 - 1);

      pointer.current.x = x;
      pointer.current.y = y;
      // A margin outside the box still counts, so the ripple fades as the
      // cursor approaches rather than snapping on at the boundary.
      pointer.current.inside = x > -1.35 && x < 1.35 && y > -1.35 && y < 1.35;
    };

    const onLeave = () => {
      pointer.current.inside = false;
    };

    window.addEventListener("pointermove", onMove, { passive: true });
    document.addEventListener("pointerleave", onLeave);
    return () => {
      window.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerleave", onLeave);
    };
  }, []);

  return (
    <div ref={host} className={className} aria-hidden>
      <Canvas
        // Cap DPR: at 3x on a high-density display this shader is fill-bound
        // and costs far more than it looks like it should.
        dpr={[1, 1.75]}
        gl={{ antialias: true, alpha: true, powerPreference: "high-performance" }}
        camera={{ position: [0, 2.4, 5.2], fov: 42 }}
        style={{ background: "transparent" }}
      >
        <Terrain pointer={pointer} />
        <SafetyPlane />
        <Rig pointer={pointer} />
      </Canvas>
    </div>
  );
}
