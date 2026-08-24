"use client";

import React, { useMemo, useRef } from "react";
import { Canvas, useFrame, type ThreeElements } from "@react-three/fiber";
import * as THREE from "three";

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
 * nothing per frame. The only per-frame work is advancing a float uniform.
 */

const vertexShader = /* glsl */ `
  uniform float uTime;
  uniform float uAmplitude;

  varying float vHeight;
  varying vec2 vUv;

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

    pos.z += h;
    vHeight = h;

    gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  uniform vec3 uSafeColor;
  uniform vec3 uRiskColor;
  uniform vec3 uGridColor;
  uniform float uFloor;

  varying float vHeight;
  varying vec2 vUv;

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

    if (alpha < 0.004) discard;
    gl_FragColor = vec4(color, alpha);
  }
`;

function Terrain({ amplitude = 1 }: { amplitude?: number }) {
  const material = useRef<THREE.ShaderMaterial>(null);

  const uniforms = useMemo(
    () => ({
      uTime: { value: 0 },
      uAmplitude: { value: amplitude },
      uFloor: { value: -0.15 },
      uSafeColor: { value: new THREE.Color("#34d399") },
      uRiskColor: { value: new THREE.Color("#fb7185") },
      uGridColor: { value: new THREE.Color("#4f46e5") },
    }),
    [amplitude]
  );

  useFrame((_, delta) => {
    // Advance by delta rather than elapsed time so a dropped frame slows the
    // motion instead of making it jump.
    if (material.current) {
      material.current.uniforms.uTime.value += delta;
    }
  });

  return (
    <mesh rotation={[-Math.PI / 2.32, 0, 0]} position={[0, -0.6, 0]}>
      <planeGeometry args={[16, 11, 190, 130]} />
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
    <mesh rotation={[-Math.PI / 2.32, 0, 0]} position={[0, -0.75, 0.001]}>
      <planeGeometry args={[16, 11]} />
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

    const targetX = Math.sin(t * 0.11) * 0.55 + p.x * 0.9;
    const targetY = 2.4 + Math.sin(t * 0.16) * 0.16 - p.y * 0.5;

    state.camera.position.x += (targetX - state.camera.position.x) * Math.min(delta * 1.6, 1);
    state.camera.position.y += (targetY - state.camera.position.y) * Math.min(delta * 1.6, 1);
    state.camera.lookAt(0, -0.5, -1.2);
  });
  return null;
}

export default function RunwayTerrain({ className }: { className?: string }) {
  const pointer = useRef({ x: 0, y: 0 });

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    pointer.current = {
      x: (event.clientX - rect.left) / rect.width - 0.5,
      y: (event.clientY - rect.top) / rect.height - 0.5,
    };
  };

  return (
    <div className={className} onPointerMove={onPointerMove} aria-hidden>
      <Canvas
        // Cap DPR: at 3x on a high-density display this shader is fill-bound
        // and costs far more than it looks like it should.
        dpr={[1, 1.75]}
        gl={{ antialias: true, alpha: true, powerPreference: "high-performance" }}
        camera={{ position: [0, 2.4, 5.2], fov: 42 }}
        style={{ background: "transparent" }}
      >
        <Terrain />
        <SafetyPlane />
        <Rig pointer={pointer} />
      </Canvas>
    </div>
  );
}

// R3F augments JSX with three.js elements; referencing the type here keeps the
// import meaningful to the linter without widening anything.
export type { ThreeElements };
