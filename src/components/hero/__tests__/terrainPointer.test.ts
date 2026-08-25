import { describe, it, expect, beforeEach } from "vitest";
import * as THREE from "three";
import {
  TERRAIN,
  createPointerScratch,
  pointerToTerrainUV,
  type PointerScratch,
} from "../terrainPointer";

/**
 * The cursor-to-terrain mapping.
 *
 * This is the half of the hover ripple that can be wrong without looking wrong:
 * a sign error in the rotation, or an off-by-half in the UV range, produces a
 * ripple that trails the cursor by a fixed offset or moves the wrong way. By
 * eye that reads as "a bit odd"; here it fails.
 *
 * The camera and mesh are constructed exactly as the scene builds them, so if
 * the scene's placement changes without these being updated, the expectations
 * about screen direction start failing.
 */

const CAMERA_POSITION = new THREE.Vector3(0, 2.4, 5.2);
const LOOK_AT = new THREE.Vector3(0, -0.5, -1.2);

let camera: THREE.PerspectiveCamera;
let mesh: THREE.Mesh;
let scratch: PointerScratch;

beforeEach(() => {
  camera = new THREE.PerspectiveCamera(42, 16 / 9, 0.1, 100);
  camera.position.copy(CAMERA_POSITION);
  camera.lookAt(LOOK_AT);
  camera.updateMatrixWorld(true);

  mesh = new THREE.Mesh(new THREE.PlaneGeometry(TERRAIN.width, TERRAIN.height, 4, 4));
  mesh.rotation.set(TERRAIN.rotationX, 0, 0);
  mesh.position.set(0, TERRAIN.y, 0);
  mesh.updateMatrixWorld(true);

  scratch = createPointerScratch();
});

describe("Terrain placement", () => {
  it("is shared with the scene rather than duplicated", () => {
    // If these drift, the ripple lands somewhere other than under the cursor.
    expect(TERRAIN.width).toBe(16);
    expect(TERRAIN.height).toBe(11);
    expect(TERRAIN.rotationX).toBeCloseTo(-Math.PI / 2.32, 6);
    expect(TERRAIN.y).toBe(-0.6);
  });
});

describe("Mapping the cursor onto the terrain", () => {
  it("puts the screen centre on the surface", () => {
    const hit = pointerToTerrainUV(0, 0, camera, mesh, scratch);

    expect(hit).not.toBeNull();
    expect(hit!.u).toBeGreaterThanOrEqual(0);
    expect(hit!.u).toBeLessThanOrEqual(1);
    expect(hit!.v).toBeGreaterThanOrEqual(0);
    expect(hit!.v).toBeLessThanOrEqual(1);
  });

  it("centres horizontally when the cursor is centred horizontally", () => {
    // The camera sits on x = 0 and looks down x = 0, so the centre column of
    // the screen must map to the centre column of the terrain.
    const hit = pointerToTerrainUV(0, 0, camera, mesh, scratch);
    expect(hit!.u).toBeCloseTo(0.5, 5);
  });

  it("moves the ripple right when the cursor moves right", () => {
    const left = pointerToTerrainUV(-0.5, 0, camera, mesh, scratch);
    const centre = pointerToTerrainUV(0, 0, camera, mesh, scratch);
    const right = pointerToTerrainUV(0.5, 0, camera, mesh, scratch);

    expect(left).not.toBeNull();
    expect(right).not.toBeNull();
    // Strictly increasing: this is the assertion that catches a flipped sign.
    expect(left!.u).toBeLessThan(centre!.u);
    expect(centre!.u).toBeLessThan(right!.u);
  });

  it("moves the ripple away from the camera as the cursor moves up", () => {
    // Screen-up is deeper into the scene, which is +v on the terrain (the
    // horizon edge). A sign error here would make the ripple chase the cursor
    // in the wrong direction vertically.
    const low = pointerToTerrainUV(0, -0.4, camera, mesh, scratch);
    const high = pointerToTerrainUV(0, 0.1, camera, mesh, scratch);

    expect(low).not.toBeNull();
    expect(high).not.toBeNull();
    expect(high!.v).toBeGreaterThan(low!.v);
  });

  it("is symmetric about the centre column", () => {
    const left = pointerToTerrainUV(-0.35, -0.2, camera, mesh, scratch);
    const right = pointerToTerrainUV(0.35, -0.2, camera, mesh, scratch);

    expect(left).not.toBeNull();
    expect(right).not.toBeNull();
    // Equal distance either side of centre, and the same depth.
    expect(left!.u - 0.5).toBeCloseTo(-(right!.u - 0.5), 5);
    expect(left!.v).toBeCloseTo(right!.v, 5);
  });

  it("reports a miss when the ray never reaches the surface", () => {
    // Far above the horizon the ray travels away from the plane entirely, or
    // meets it far outside the terrain's bounds. Either way there is nothing
    // to ripple, and the caller must ease the effect out rather than clamp the
    // ripple to an edge.
    expect(pointerToTerrainUV(0, 0.98, camera, mesh, scratch)).toBeNull();
  });

  it("reports a miss well outside the terrain's left edge", () => {
    expect(pointerToTerrainUV(-4, -0.2, camera, mesh, scratch)).toBeNull();
  });

  it("never returns a UV outside 0…1", () => {
    // Sweep the viewport. Anything the function accepts must be addressable in
    // the shader; a UV outside the range would sample the ripple off-surface.
    for (let x = -1; x <= 1; x += 0.1) {
      for (let y = -1; y <= 1; y += 0.1) {
        const hit = pointerToTerrainUV(x, y, camera, mesh, scratch);
        if (!hit) continue;
        expect(hit.u).toBeGreaterThanOrEqual(0);
        expect(hit.u).toBeLessThanOrEqual(1);
        expect(hit.v).toBeGreaterThanOrEqual(0);
        expect(hit.v).toBeLessThanOrEqual(1);
      }
    }
  });

  it("allocates nothing per call", () => {
    // The scratch object exists so this can run every frame. Calling it twice
    // must reuse the same vectors rather than replace them.
    const ray = scratch.raycaster;
    const hitVec = scratch.hit;

    pointerToTerrainUV(0.1, -0.1, camera, mesh, scratch);
    pointerToTerrainUV(-0.2, 0.05, camera, mesh, scratch);

    expect(scratch.raycaster).toBe(ray);
    expect(scratch.hit).toBe(hitVec);
  });
});
