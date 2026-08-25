import * as THREE from "three";

/**
 * Where the cursor lands on the terrain.
 *
 * Split out from the scene so it can be tested without a renderer. This is the
 * part most likely to be silently wrong — the plane is rotated and offset, and
 * an error in the rotation or the UV range produces a ripple that trails the
 * cursor by a constant amount, which is easy to miss by eye and obvious in a
 * test.
 *
 * The ray is intersected with the terrain's mathematical PLANE rather than its
 * geometry. The mesh carries ~50k triangles and this runs every frame for a
 * decorative effect; a plane intersection is O(1) and, since the displacement
 * happens in the vertex shader, the CPU-side geometry is flat anyway — so
 * raycasting the real mesh would not be more accurate, only slower.
 */

/** Terrain placement. The scene and these helpers must agree on all of it. */
export const TERRAIN = {
  rotationX: -Math.PI / 2.32,
  y: -0.6,
  width: 16,
  height: 11,
} as const;

export interface TerrainHit {
  /** Terrain UV, both in 0…1. */
  u: number;
  v: number;
}

export interface PointerScratch {
  raycaster: THREE.Raycaster;
  plane: THREE.Plane;
  normal: THREE.Vector3;
  hit: THREE.Vector3;
  ndc: THREE.Vector2;
  quat: THREE.Quaternion;
}

/** Allocate once per scene; reused every frame so nothing is allocated in the loop. */
export function createPointerScratch(): PointerScratch {
  return {
    raycaster: new THREE.Raycaster(),
    plane: new THREE.Plane(),
    normal: new THREE.Vector3(),
    hit: new THREE.Vector3(),
    ndc: new THREE.Vector2(),
    quat: new THREE.Quaternion(),
  };
}

/**
 * Maps normalised device coordinates to terrain UV.
 *
 * Returns null when the ray misses the plane entirely, or hits it outside the
 * terrain's bounds — the caller treats both as "not over the surface" and eases
 * the ripple out.
 */
export function pointerToTerrainUV(
  ndcX: number,
  ndcY: number,
  camera: THREE.Camera,
  mesh: THREE.Object3D,
  scratch: PointerScratch
): TerrainHit | null {
  scratch.ndc.set(ndcX, ndcY);
  scratch.raycaster.setFromCamera(scratch.ndc, camera);

  // The plane's local +Z normal, rotated into world space, through the origin
  // of the mesh.
  mesh.getWorldQuaternion(scratch.quat);
  scratch.normal.set(0, 0, 1).applyQuaternion(scratch.quat);
  scratch.plane.setFromNormalAndCoplanarPoint(scratch.normal, mesh.position);

  if (!scratch.raycaster.ray.intersectPlane(scratch.plane, scratch.hit)) {
    return null;
  }

  // World hit → the mesh's local space → the geometry's UV range. planeGeometry
  // is centred on its origin, so local x spans ±width/2 and y spans ±height/2.
  mesh.worldToLocal(scratch.hit);
  const u = scratch.hit.x / TERRAIN.width + 0.5;
  const v = scratch.hit.y / TERRAIN.height + 0.5;

  if (u < 0 || u > 1 || v < 0 || v > 1) return null;
  return { u, v };
}
