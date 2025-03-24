import {StyleLayer} from '../style_layer';

import properties, {type HillshadePaintPropsPossiblyEvaluated} from './hillshade_style_layer_properties.g';
import {type Transitionable, type Transitioning, type PossiblyEvaluated} from '../properties';

import type {HillshadePaintProps} from './hillshade_style_layer_properties.g';
import {Interpolate, ZoomConstantExpression, type LayerSpecification} from '@maplibre/maplibre-gl-style-spec';
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
        if (expression instanceof ZoomConstantExpression && expression._styleExpression.expression instanceof Interpolate) {
            const interpolater = expression._styleExpression.expression;
            this.elevationRange = {start: interpolater.labels[0], end: interpolater.labels[interpolater.labels.length-1]};
            this.colorRamp = renderColorRamp({
                expression,
                evaluationKey: 'elevation',
                image: this.colorRamp,
                clips: [this.elevationRange]
            });
        } else{
            this.elevationRange = {start:0, end:1};
            this.colorRamp = null;
        }
        this.colorRampTexture = null;
    }

    hasOffscreenPass() {
        return this.visibility !== 'none' && (this.paint.get('hillshade-exaggeration') !== 0 ||  !!this.colorRamp);
    }
}
