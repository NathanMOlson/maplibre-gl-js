import {OverscaledTileID} from '../../source/tile_id';
import {Aabb} from '../../util/primitives';
import {MercatorCoordinate} from '../mercator_coordinate';
import {IReadonlyTransform} from '../transform_interface';
import {CoveringTilesDetailsProvider, CoveringTilesOptions} from './covering_tiles';

export class MercatorCoveringTilesDetailsProvider implements CoveringTilesDetailsProvider {

    distanceToTile2d(pointX: number, pointY: number, tileID: {x: number; y: number; z: number}, aabb: Aabb): number {
        const distanceX = aabb.distanceX([pointX, pointY]);
        const distanceY = aabb.distanceY([pointX, pointY]);
        return Math.hypot(distanceX, distanceY);
    }

    // Returns the wrap value for a given tile, computed so that tiles will remain loaded when crossing the antimeridian.
    getWrap(centerCoord: MercatorCoordinate, tileID: {x:number; y: number; z: number}, parentWrap: number): number {
        return parentWrap;
    }

    /**
     * Returns the AABB of the specified tile.
     * @param tileID - Tile x, y and z for zoom.
     */
    getTileAABB(tileID: {x: number; y: number; z: number}, wrap: number, elevation: number, options: CoveringTilesOptions): Aabb {
        let minElevation = elevation;
        let maxElevation = elevation;
        if (options.terrain) {
            const overscaledTileID = new OverscaledTileID(tileID.z, wrap, tileID.z, tileID.x, tileID.y);
            const minMax = options.terrain.getMinMaxElevation(overscaledTileID);
            minElevation = minMax.minElevation ?? elevation;
            maxElevation = minMax.maxElevation ?? elevation;
        }
        const numTiles = 1 << tileID.z;
        return new Aabb([wrap + tileID.x / numTiles, tileID.y / numTiles, minElevation],
            [wrap + (tileID.x + 1) / numTiles, (tileID.y + 1) / numTiles, maxElevation]);
    }
    
    allowVariableZoom(transform: IReadonlyTransform, options: CoveringTilesOptions): boolean {
        return (!!options.terrain || transform.pitch > 60.0 || transform.padding.top >= 0.1)
    }
}