import {StyleLayer} from '../style_layer';

import properties, {type HillshadePaintPropsPossiblyEvaluated} from './hillshade_style_layer_properties.g';
import {type Transitionable, type Transitioning, type PossiblyEvaluated} from '../properties';

import type {HillshadePaintProps} from './hillshade_style_layer_properties.g';
import type {LayerSpecification} from '@maplibre/maplibre-gl-style-spec';
import { Texture } from '../../render/texture';
import { RGBAImage } from '../../util/image';
import { renderColorRamp } from '../../util/color_ramp';

export const isHillshadeStyleLayer = (layer: StyleLayer): layer is HillshadeStyleLayer => layer.type === 'hillshade';

export class HillshadeStyleLayer extends StyleLayer {
    colorRamp: RGBAImage;
    colorRampTexture: Texture;
    elevationRange: {start: number, end: number};
    _transitionablePaint: Transitionable<HillshadePaintProps>;
    _transitioningPaint: Transitioning<HillshadePaintProps>;
    paint: PossiblyEvaluated<HillshadePaintProps, HillshadePaintPropsPossiblyEvaluated>;

    constructor(layer: LayerSpecification) {
        super(layer, properties);
        this._updateColorRamp();
    }
    
    _updateColorRamp() {
        const expression = this._transitionablePaint._values['color-relief'].value.expression;
        this.elevationRange = {start:0, end:3000};
        this.colorRamp = renderColorRamp({
            expression,
            evaluationKey: 'elevation',
            image: this.colorRamp,
            clips: [this.elevationRange]
        });
        this.colorRampTexture = null;
    }

    hasOffscreenPass() {
        return this.paint.get('hillshade-exaggeration') !== 0 && this.visibility !== 'none';
    }
}
