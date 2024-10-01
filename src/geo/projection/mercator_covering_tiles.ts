import {vec2} from 'gl-matrix';
import {OverscaledTileID} from '../../source/tile_id';
import {Aabb, Frustum, IntersectionResult} from '../../util/primitives';
import {MercatorCoordinate} from '../mercator_coordinate';
import {CoveringTilesOptions, IReadonlyTransform} from '../transform_interface';
import {scaleZoom} from '../transform_helper';
import {CoveringTilesResult, CoveringTilesStackEntry, isTileVisible} from './covering_tiles';

function distanceToTile2d(pointX: number, pointY: number, tileID: {x: number; y: number; z: number}, aabb: Aabb): number {
    const distanceX = aabb.distanceX([pointX, pointY]);
    const distanceY = aabb.distanceY([pointX, pointY]);
    return Math.hypot(distanceX, distanceY);
}

// Returns the wrap value for a given tile, computed so that tiles will remain loaded when crossing the antimeridian.
function getWrap(centerCoord: MercatorCoordinate, tileID: {x:number; y: number; z: number}, parentWrap: number): number {
    return parentWrap;
}

/**
 * Returns the AABB of the specified tile.
 * @param tileID - Tile x, y and z for zoom.
 */
export function getTileAABB(tileID: {x: number; y: number; z: number}, wrap: number, elevation: number, options: CoveringTilesOptions): Aabb {
    let minElevation = elevation;
    let maxElevation = elevation;
    if (options.terrain) {
        const tileID = new OverscaledTileID(tileID.z, wrap, tileID.z, tileID.x, tileID.y);
        const minMax = options.terrain.getMinMaxElevation(tileID);
        minElevation = minMax.minElevation ?? elevation;
        maxElevation = minMax.maxElevation ?? elevation;
    }
    const numTiles = 1 << tileID.z;
    return new Aabb([wrap + tileID.x / numTiles, tileID.y / numTiles, minElevation],
        [wrap + (tileID.x + 1) / numTiles, (tileID.y + 1) / numTiles, maxElevation]);
}

/**
 * Returns a list of tiles that optimally covers the screen.
 * Correctly handles LOD when moving over the antimeridian.
 * @param transform - The mercator transform instance.
 * @param options - Additional coveringTiles options.
 * @param invViewProjMatrix - Inverse view projection matrix, for computing camera frustum.
 * @returns A list of tile coordinates, ordered by ascending distance from camera.
 */
export function mercatorCoveringTiles(transform: IReadonlyTransform, frustum: Frustum, plane: vec4, cameraCoord: MercatorCoordinate, centerCoord: MercatorCoordinate, options: CoveringTilesOptions): Array<OverscaledTileID> {
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

    // No change of LOD behavior for pitch lower than 60 and when there is no top padding: return only tile ids from the requested zoom level
    // Use 0.1 as an epsilon to avoid for explicit == 0.0 floating point checks
    const allowZariableZoom = options.terrain || transform.pitch > 60.0 || transform.padding.top >= 0.1;

    const newRootTile = (wrap: number): any => {
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
        const aabb = getTileAABB(tileID, it.wrap, transform.elevation, options);

        // Visibility of a tile is not required if any of its ancestor is fully visible
        if (!fullyVisible) {
            const intersectResult = isTileVisible(frustum, plane, aabb);

            if (intersectResult === IntersectionResult.None)
                continue;

            fullyVisible = intersectResult === IntersectionResult.Full;
        }

        const distToTile2d = distanceToTile2d(cameraCoord.x, cameraCoord.y, tileID, aabb);
        const distToTile3d = Math.hypot(distToTile2d, distanceZ);

        let thisTileDesiredZ = desiredZ;
        if (allowZariableZoom) {
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
        it.wrap = getWrap(centerCoord, tileID, it.wrap);

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
