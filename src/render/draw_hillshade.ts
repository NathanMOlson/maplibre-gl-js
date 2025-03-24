import {Texture} from './texture';
import {StencilMode} from '../gl/stencil_mode';
import {DepthMode} from '../gl/depth_mode';
import {CullFaceMode} from '../gl/cull_face_mode';
import {type ColorMode} from '../gl/color_mode';
import {
    hillshadeUniformValues,
    hillshadeUniformPrepareValues
} from './program/hillshade_program';

import type {Painter, RenderOptions} from './painter';
import type {SourceCache} from '../source/source_cache';
import type {HillshadeStyleLayer} from '../style/style_layer/hillshade_style_layer';
import type {OverscaledTileID} from '../source/tile_id';
import { RGBAImage } from '../util/image';
import { lerp } from '../util/util';
import { Color } from '@maplibre/maplibre-gl-style-spec';

export function drawHillshade(painter: Painter, sourceCache: SourceCache, layer: HillshadeStyleLayer, tileIDs: Array<OverscaledTileID>, renderOptions: RenderOptions) {
    if (painter.renderPass !== 'offscreen' && painter.renderPass !== 'translucent') return;

    const {isRenderingToTexture} = renderOptions;
    const context = painter.context;
    const projection = painter.style.projection;
    const useSubdivision = projection.useSubdivision;

    const depthMode = painter.getDepthModeForSublayer(0, DepthMode.ReadOnly);
    const colorMode = painter.colorModeForRenderPass();

    if (painter.renderPass === 'offscreen') {
        // Prepare tiles
        prepareHillshade(painter, sourceCache, tileIDs, layer, depthMode, StencilMode.disabled, colorMode);
        context.viewport.set([0, 0, painter.width, painter.height]);
    } else if (painter.renderPass === 'translucent') {
        // Globe (or any projection with subdivision) needs two-pass rendering to avoid artifacts when rendering texture tiles.
        // See comments in draw_raster.ts for more details.
        if (useSubdivision) {
            // Two-pass rendering
            const [stencilBorderless, stencilBorders, coords] = painter.stencilConfigForOverlapTwoPass(tileIDs);
            renderHillshade(painter, sourceCache, layer, coords, stencilBorderless, depthMode, colorMode, false, isRenderingToTexture); // draw without borders
            renderHillshade(painter, sourceCache, layer, coords, stencilBorders, depthMode, colorMode, true, isRenderingToTexture); // draw with borders
        } else {
            // Simple rendering
            const [stencil, coords] = painter.getStencilConfigForOverlapAndUpdateStencilID(tileIDs);
            renderHillshade(painter, sourceCache, layer, coords, stencil, depthMode, colorMode, false, isRenderingToTexture);
        }
    }
}
export class ElevationColormap
{
    colormap: Uint8Array;
    scale: number;
    elevationStart: number;

    constructor(colormapSpec: Array<number | Color>) {
        const colormapSize = 256;
        this.elevationStart = colormapSpec[0] as number;
        const elevationEnd = colormapSpec[colormapSpec.length-2] as number;
        this.scale = 4.0 / (elevationEnd - this.elevationStart);
        this.colormap = new Uint8Array(colormapSize*4);

        let elevationIndex = 0;

        for(let i = 0; i < colormapSize; i++) {
            const elevation = lerp(this.elevationStart, elevationEnd, i/(colormapSize-1));
            while(elevationIndex < colormapSpec.length/2 - 1 && (colormapSpec[2*elevationIndex + 2] as number) < elevation) {
                elevationIndex++;
            }
            const e1 = colormapSpec[2*elevationIndex] as number;
            const c1 = colormapSpec[2*elevationIndex+1] as Color;
            const e2 = colormapSpec[2*elevationIndex+2] as number;
            const c2 = colormapSpec[2*elevationIndex+3] as Color;
            const mix = (elevation - e1) / (e2 - e1);
            for(let j = 0; j < 4; j++) {
                this.colormap[4*i+j] = 255*((1-mix)*c1.rgb[j] + mix*c2.rgb[j]);
            }
        }
    }
}

function renderHillshade(
    painter: Painter,
    sourceCache: SourceCache,
    layer: HillshadeStyleLayer,
    coords: Array<OverscaledTileID>,
    stencilModes: {[_: number]: Readonly<StencilMode>},
    depthMode: Readonly<DepthMode>,
    colorMode: Readonly<ColorMode>,
    useBorder: boolean,
    isRenderingToTexture: boolean
) {
    const projection = painter.style.projection;
    const context = painter.context;
    const transform = painter.transform;
    const gl = context.gl;
    const program = painter.useProgram('hillshade');
    const align = !painter.options.moving;


    const colormapSpec = new Array<number | Color>(0, Color.parse("#000088"), 10, Color.parse("#00AA00"), 1500, Color.parse("#884422"), 3000, Color.parse("#FFFFFF"));
    context.activeTexture.set(gl.TEXTURE5);
    const elevationColormap = new ElevationColormap(colormapSpec);
    const colormapTexture = new Texture(context, new RGBAImage({width: elevationColormap.colormap.length/4, height: 1}, elevationColormap.colormap), gl.RGBA);
    colormapTexture.bind(gl.LINEAR, gl.CLAMP_TO_EDGE);

    for (const coord of coords) {
        const tile = sourceCache.getTile(coord);
        const fbo = tile.fbo;
        if (!fbo) {
            continue;
        }
        const mesh = projection.getMeshFromTileID(context, coord.canonical, useBorder, true, 'raster');

        const terrainData = painter.style.map.terrain?.getTerrainData(coord);

        context.activeTexture.set(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, fbo.colorAttachment.get());

        const projectionData = transform.getProjectionData({
            overscaledTileID: coord,
            aligned: align,
            applyGlobeMatrix: !isRenderingToTexture,
            applyTerrainMatrix: true
        });

        program.draw(context, gl.TRIANGLES, depthMode, stencilModes[coord.overscaledZ], colorMode, CullFaceMode.backCCW,
            hillshadeUniformValues(painter, tile, layer, elevationColormap), terrainData, projectionData, layer.id, mesh.vertexBuffer, mesh.indexBuffer, mesh.segments);
    }
}

// hillshade rendering is done in two steps. the prepare step first calculates the slope of the terrain in the x and y
// directions for each pixel, and saves those values to a framebuffer texture in the r and g channels.
function prepareHillshade(
    painter: Painter,
    sourceCache: SourceCache,
    tileIDs: Array<OverscaledTileID>,
    layer: HillshadeStyleLayer,
    depthMode: Readonly<DepthMode>,
    stencilMode: Readonly<StencilMode>,
    colorMode: Readonly<ColorMode>) {

    const context = painter.context;
    const gl = context.gl;

    for (const coord of tileIDs) {
        const tile = sourceCache.getTile(coord);
        const dem = tile.dem;

        if (!dem || !dem.data) {
            continue;
        }

        if (!tile.needsHillshadePrepare) {
            continue;
        }

        const tileSize = dem.dim;
        const textureStride = dem.stride;

        const pixelData = dem.getPixels();
        context.activeTexture.set(gl.TEXTURE1);

        context.pixelStoreUnpackPremultiplyAlpha.set(false);
        tile.demTexture = tile.demTexture || painter.getTileTexture(textureStride);
        if (tile.demTexture) {
            const demTexture = tile.demTexture;
            demTexture.update(pixelData, {premultiply: false});
            demTexture.bind(gl.NEAREST, gl.CLAMP_TO_EDGE);
        } else {
            tile.demTexture = new Texture(context, pixelData, gl.RGBA, {premultiply: false});
            tile.demTexture.bind(gl.NEAREST, gl.CLAMP_TO_EDGE);
        }

        context.activeTexture.set(gl.TEXTURE0);

        let fbo = tile.fbo;

        if (!fbo) {
            const renderTexture = new Texture(context, {width: tileSize, height: tileSize, data: null}, gl.RGBA);
            renderTexture.bind(gl.LINEAR, gl.CLAMP_TO_EDGE);

            fbo = tile.fbo = context.createFramebuffer(tileSize, tileSize, true, false);
            fbo.colorAttachment.set(renderTexture.texture);
        }

        context.bindFramebuffer.set(fbo.framebuffer);
        context.viewport.set([0, 0, tileSize, tileSize]);

        painter.useProgram('hillshadePrepare').draw(context, gl.TRIANGLES,
            depthMode, stencilMode, colorMode, CullFaceMode.disabled,
            hillshadeUniformPrepareValues(tile.tileID, dem),
            null, null, layer.id, painter.rasterBoundsBuffer,
            painter.quadTriangleIndexBuffer, painter.rasterBoundsSegments);

        tile.needsHillshadePrepare = false;
    }
}
