import {OverscaledTileID} from '../../source/tile_id';
import {Aabb, Frustum, IntersectionResult} from '../../util/primitives';
import {vec2, vec4} from 'gl-matrix';
import {CoveringTilesOptions, IReadonlyTransform} from '../transform_interface';
import {MercatorCoordinate} from '../mercator_coordinate';
import {scaleZoom} from '../transform_helper';

type CoveringTilesResult = {
    tileID: OverscaledTileID;
    distanceSq: number;
    tileDistanceToCamera: number;
};

type CoveringTilesStackEntry = {
    zoom: number;
    x: number;
    y: number;
    wrap: number;
    fullyVisible: boolean;
};

export interface CoveringTilesDetails {
    /**
     * Returns the distance from the point to the tile
     * @param pointX - point x.
     * @param pointY - point y.
     * @param tileID - Tile x, y and z for zoom.
     * @param aabb - tile AABB
     */
    distanceToTile2d: (pointX: number, pointY: number, tileID: {x: number; y: number; z: number}, aabb: Aabb) => number;

    // Returns the wrap value for a given tile.
    getWrap: (centerCoord: MercatorCoordinate, tileID: {x:number; y: number; z: number}, parentWrap: number) => number;

    /**
     * Returns the AABB of the specified tile.
     * @param tileID - Tile x, y and z for zoom.
     * @param wrap - wrap number of the tile.
     * @param elevation - camera center point elevation.
     * @param options - CoveringTilesOptions.
     */
    getTileAABB: (tileID: {x: number; y: number; z: number}, wrap: number, elevation: number, options: CoveringTilesOptions) => Aabb;

    /**
     * Whether to allow variable zoom, which is used at high pitch angle to avoid loading an excessive amount of tiles.
     */
    allowVariableZoom: boolean;
}

/**
 * A simple/heuristic function that returns whether the tile is visible under the current transform.
 * @returns an {@link IntersectionResult}.
 */
export function isTileVisible(frustum: Frustum, aabb: Aabb, plane?: vec4): IntersectionResult {

    const frustumTest = aabb.intersectsFrustum(frustum);
    if (!plane) {
        return frustumTest;
    }
    const planeTest = aabb.intersectsPlane(plane);

    if (frustumTest === IntersectionResult.None || planeTest === IntersectionResult.None) {
        return IntersectionResult.None;
    }

    if (frustumTest === IntersectionResult.Full && planeTest === IntersectionResult.Full) {
        return IntersectionResult.Full;
    }

    return IntersectionResult.Partial;
}

/**
 * Returns a list of tiles that optimally covers the screen. Adapted for globe projection.
 * Correctly handles LOD when moving over the antimeridian.
 * @param transform - The transform instance.
 * @param frustum - The covering frustum.
 * @param plane - The clipping plane used by globe transform, or null.
 * @param cameraCoord - The x, y, z position of the camera in MercatorCoordinates.
 * @param cameraCoord - The x, y, z position of the center point in MercatorCoordinates.
 * @param options - Additional coveringTiles options.
 * @param details - Interface to define required helper functions.
 * @returns A list of tile coordinates, ordered by ascending distance from camera.
 */
export function coveringTiles(transform: IReadonlyTransform, frustum: Frustum, plane: vec4, cameraCoord: MercatorCoordinate, centerCoord: MercatorCoordinate, options: CoveringTilesOptions, details: CoveringTilesDetails): OverscaledTileID[] {
    const desiredZ = transform.coveringZoomLevel(options);
    const minZoom = options.minzoom || 0;
    const maxZoom = options.maxzoom !== undefined ? options.maxzoom : transform.maxZoom;
    const nominalZ = Math.min(Math.max(0, desiredZ), maxZoom);

    const numTiles = Math.pow(2, nominalZ);
    const cameraPoint = [numTiles * cameraCoord.x, numTiles * cameraCoord.y, 0];
    const centerPoint = [numTiles * centerCoord.x, numTiles * centerCoord.y, 0];
    const distanceToCenter2d = Math.hypot(centerCoord.x - cameraCoord.x, centerCoord.y - cameraCoord.y);
    const distanceZ = Math.abs(centerCoord.z - cameraCoord.z);
    const distanceToCenter3d = Math.hypot(distanceToCenter2d, distanceZ);

    const newRootTile = (wrap: number): CoveringTilesStackEntry => {
        return {
            zoom: 0,
            x: 0,
            y: 0,
            wrap,
            fullyVisible: false
        };
    };

    // Do a depth-first traversal to find visible tiles and proper levels of detail
    const stack: Array<CoveringTilesStackEntry> = [];
    const result: Array<CoveringTilesResult> = [];

    if (transform.renderWorldCopies) {
        // Render copy of the globe thrice on both sides
        for (let i = 1; i <= 3; i++) {
            stack.push(newRootTile(-i));
            stack.push(newRootTile(i));
        }
    }

    stack.push(newRootTile(0));

    while (stack.length > 0) {
        const it = stack.pop();
        const x = it.x;
        const y = it.y;
        let fullyVisible = it.fullyVisible;
        const tileID = {x, y, z: it.zoom};
        const aabb = details.getTileAABB(tileID, it.wrap, transform.elevation, options);

        // Visibility of a tile is not required if any of its ancestor is fully visible
        if (!fullyVisible) {
            const intersectResult = isTileVisible(frustum, aabb, plane);

            if (intersectResult === IntersectionResult.None)
                continue;

            fullyVisible = intersectResult === IntersectionResult.Full;
        }

        const distToTile2d = details.distanceToTile2d(cameraCoord.x, cameraCoord.y, tileID, aabb);
        const distToTile3d = Math.hypot(distToTile2d, distanceZ);

        let thisTileDesiredZ = desiredZ;
        if (details.allowVariableZoom) {
            const thisTilePitch = Math.atan(distToTile2d / distanceZ);
            // if distance to candidate tile is a tiny bit farther than distance to center,
            // use the same zoom as the center. This is achieved by the scaling distance ratio by cos(fov/2)
            thisTileDesiredZ = (options.roundZoom ? Math.round : Math.floor)(
                transform.zoom + transform.pitchBehavior * scaleZoom(Math.cos(thisTilePitch)) / 2 + scaleZoom(transform.tileSize / options.tileSize * distanceToCenter3d / distToTile3d / Math.cos(transform.fov / 2.0 * Math.PI / 180.0))
            );
        }
        thisTileDesiredZ = Math.max(0, thisTileDesiredZ);
        const z = Math.min(thisTileDesiredZ, maxZoom);

        // We need to compute a valid wrap value for the tile to keep globe compatibility with mercator
        it.wrap = details.getWrap(centerCoord, tileID, it.wrap);

        // Have we reached the target depth?
        if (it.zoom >= z) {
            if (it.zoom < minZoom) {
                continue;
            }
            const dz = nominalZ - it.zoom;
            const dx = cameraPoint[0] - 0.5 - (x << dz);
            const dy = cameraPoint[1] - 0.5 - (y << dz);
            const overscaledZ = options.reparseOverscaled ? thisTileDesiredZ : it.zoom;
            result.push({
                tileID: new OverscaledTileID(it.zoom === maxZoom ? overscaledZ : it.zoom, it.wrap, it.zoom, x, y),
                distanceSq: vec2.sqrLen([centerPoint[0] - 0.5 - x, centerPoint[1] - 0.5 - y]),
                // this variable is currently not used, but may be important to reduce the amount of loaded tiles
                tileDistanceToCamera: Math.sqrt(dx * dx + dy * dy)
            });
            continue;
        }

        for (let i = 0; i < 4; i++) {
            const childX = (x << 1) + (i % 2);
            const childY = (y << 1) + (i >> 1);
            const childZ = it.zoom + 1;
            stack.push({zoom: childZ, x: childX, y: childY, wrap: it.wrap, fullyVisible});
        }
    }

    return result.sort((a, b) => a.distanceSq - b.distanceSq).map(a => a.tileID);
}