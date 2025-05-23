import {
    charHasUprightVerticalOrientation,
    charAllowsIdeographicBreaking,
    charInComplexShapingScript
} from '../util/script_detection';
import {verticalizePunctuation} from '../util/verticalize_punctuation';
import {rtlWorkerPlugin} from '../source/rtl_text_plugin_worker';
import ONE_EM from './one_em';
import {warnOnce} from '../util/util';

import type {StyleGlyph, GlyphMetrics} from '../style/style_glyph';
import {GLYPH_PBF_BORDER} from '../style/parse_glyph_pbf';
import {TextFit} from '../style/style_image';
import type {ImagePosition} from '../render/image_atlas';
import {IMAGE_PADDING} from '../render/image_atlas';
import type {Rect, GlyphPosition} from '../render/glyph_atlas';
import {type Formatted, type FormattedSection, type VerticalAlign} from '@maplibre/maplibre-gl-style-spec';

enum WritingMode {
    none = 0,
    horizontal = 1,
    vertical = 2,
    horizontalOnly = 3
}

const SHAPING_DEFAULT_OFFSET = -17;
export {shapeText, shapeIcon, applyTextFit, fitIconToText, getAnchorAlignment, WritingMode, SHAPING_DEFAULT_OFFSET};

// The position of a glyph relative to the text's anchor point.
export type PositionedGlyph = {
    glyph: number;
    imageName: string | null;
    x: number;
    y: number;
    vertical: boolean;
    scale: number;
    fontStack: string;
    sectionIndex: number;
    metrics: GlyphMetrics;
    rect: Rect | null;
};

export type PositionedLine = {
    positionedGlyphs: Array<PositionedGlyph>;
    lineOffset: number;
};

// A collection of positioned glyphs and some metadata
export type Shaping = {
    positionedLines: Array<PositionedLine>;
    top: number;
    bottom: number;
    left: number;
    right: number;
    writingMode: WritingMode.horizontal | WritingMode.vertical;
    text: string;
    iconsInText: boolean;
    verticalizable: boolean;
};

type ShapingSectionAttributes = {
    rect: Rect | null;
    metrics: GlyphMetrics;
    baselineOffset: number;
    imageOffset?: number;
};

type LineShapingSize = {
    verticalLineContentWidth: number;
    horizontalLineContentHeight: number;
};

function isEmpty(positionedLines: Array<PositionedLine>) {
    for (const line of positionedLines) {
        if (line.positionedGlyphs.length !== 0) {
            return false;
        }
    }
    return true;
}

export type SymbolAnchor = 'center' | 'left' | 'right' | 'top' | 'bottom' | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
export type TextJustify = 'left' | 'center' | 'right';

// Max number of images in label is 6401 U+E000–U+F8FF that covers
// Basic Multilingual Plane Unicode Private Use Area (PUA).
const PUAbegin = 0xE000;
const PUAend = 0xF8FF;

class SectionOptions {
    // Text options
    scale: number;
    fontStack: string;
    // Image options
    imageName: string | null;
    // Common options
    verticalAlign: VerticalAlign;

    constructor() {
        this.scale = 1.0;
        this.fontStack = '';
        this.imageName = null;
        this.verticalAlign = 'bottom';
    }

    static forText(scale: number | null, fontStack: string, verticalAlign: VerticalAlign | null) {
        const textOptions = new SectionOptions();
        textOptions.scale = scale || 1;
        textOptions.fontStack = fontStack;
        textOptions.verticalAlign = verticalAlign || 'bottom';
        return textOptions;
    }

    static forImage(imageName: string, verticalAlign: VerticalAlign | null) {
        const imageOptions = new SectionOptions();
        imageOptions.imageName = imageName;
        imageOptions.verticalAlign = verticalAlign || 'bottom';
        return imageOptions;
    }

}

class TaggedString {
    text: string;
    sectionIndex: Array<number>; // maps each character in 'text' to its corresponding entry in 'sections'
    sections: Array<SectionOptions>;
    imageSectionID: number | null;

    constructor() {
        this.text = '';
        this.sectionIndex = [];
        this.sections = [];
        this.imageSectionID = null;
    }

    static fromFeature(text: Formatted, defaultFontStack: string) {
        const result = new TaggedString();
        for (let i = 0; i < text.sections.length; i++) {
            const section = text.sections[i];
            if (!section.image) {
                result.addTextSection(section, defaultFontStack);
            } else {
                result.addImageSection(section);
            }
        }
        return result;
    }

    length(): number {
        return this.text.length;
    }

    getSection(index: number): SectionOptions {
        return this.sections[this.sectionIndex[index]];
    }

    getSectionIndex(index: number): number {
        return this.sectionIndex[index];
    }

    getCharCode(index: number): number {
        return this.text.charCodeAt(index);
    }

    verticalizePunctuation() {
        this.text = verticalizePunctuation(this.text);
    }

    trim() {
        let beginningWhitespace = 0;
        for (let i = 0;
            i < this.text.length && whitespace[this.text.charCodeAt(i)];
            i++) {
            beginningWhitespace++;
        }
        let trailingWhitespace = this.text.length;
        for (let i = this.text.length - 1;
            i >= 0 && i >= beginningWhitespace && whitespace[this.text.charCodeAt(i)];
            i--) {
            trailingWhitespace--;
        }
        this.text = this.text.substring(beginningWhitespace, trailingWhitespace);
        this.sectionIndex = this.sectionIndex.slice(beginningWhitespace, trailingWhitespace);
    }

    substring(start: number, end: number): TaggedString {
        const substring = new TaggedString();
        substring.text = this.text.substring(start, end);
        substring.sectionIndex = this.sectionIndex.slice(start, end);
        substring.sections = this.sections;
        return substring;
    }

    toString(): string {
        return this.text;
    }

    getMaxScale() {
        return this.sectionIndex.reduce((max, index) => Math.max(max, this.sections[index].scale), 0);
    }

    getMaxImageSize(imagePositions: {[_: string]: ImagePosition}): {
        maxImageWidth: number;
        maxImageHeight: number;
    } {
        let maxImageWidth = 0;
        let maxImageHeight = 0;
        for (let i = 0; i < this.length(); i++) {
            const section = this.getSection(i);
            if (section.imageName) {
                const imagePosition = imagePositions[section.imageName];
                if (!imagePosition) continue;
                const size = imagePosition.displaySize;
                maxImageWidth = Math.max(maxImageWidth, size[0]);
                maxImageHeight = Math.max(maxImageHeight, size[1]);
            }
        }
        return {maxImageWidth, maxImageHeight};
    }

    addTextSection(section: FormattedSection, defaultFontStack: string) {
        this.text += section.text;
        this.sections.push(SectionOptions.forText(section.scale, section.fontStack || defaultFontStack, section.verticalAlign));
        const index = this.sections.length - 1;
        for (let i = 0; i < section.text.length; ++i) {
            this.sectionIndex.push(index);
        }
    }

    addImageSection(section: FormattedSection) {
        const imageName = section.image ? section.image.name : '';
        if (imageName.length === 0) {
            warnOnce('Can\'t add FormattedSection with an empty image.');
            return;
        }

        const nextImageSectionCharCode = this.getNextImageSectionCharCode();
        if (!nextImageSectionCharCode) {
            warnOnce(`Reached maximum number of images ${PUAend - PUAbegin + 2}`);
            return;
        }

        this.text += String.fromCharCode(nextImageSectionCharCode);
        this.sections.push(SectionOptions.forImage(imageName, section.verticalAlign));
        this.sectionIndex.push(this.sections.length - 1);
    }

    getNextImageSectionCharCode(): number | null {
        if (!this.imageSectionID) {
            this.imageSectionID = PUAbegin;
            return this.imageSectionID;
        }

        if (this.imageSectionID >= PUAend) return null;
        return ++this.imageSectionID;
    }
}

function breakLines(input: TaggedString, lineBreakPoints: Array<number>): Array<TaggedString> {
    const lines = [];
    const text = input.text;
    let start = 0;
    for (const lineBreak of lineBreakPoints) {
        lines.push(input.substring(start, lineBreak));
        start = lineBreak;
    }

    if (start < text.length) {
        lines.push(input.substring(start, text.length));
    }
    return lines;
}

function shapeText(
    text: Formatted,
    glyphMap: {
        [_: string]: {
            [_: number]: StyleGlyph;
        };
    },
    glyphPositions: {
        [_: string]: {
            [_: number]: GlyphPosition;
        };
    },
    imagePositions: {[_: string]: ImagePosition},
    defaultFontStack: string,
    maxWidth: number,
    lineHeight: number,
    textAnchor: SymbolAnchor,
    textJustify: TextJustify,
    spacing: number,
    translate: [number, number],
    writingMode: WritingMode.horizontal | WritingMode.vertical,
    allowVerticalPlacement: boolean,
    layoutTextSize: number,
    layoutTextSizeThisZoom: number
): Shaping | false {
    const logicalInput = TaggedString.fromFeature(text, defaultFontStack);

    if (writingMode === WritingMode.vertical) {
        logicalInput.verticalizePunctuation();
    }

    let lines: Array<TaggedString>;

    const {processBidirectionalText, processStyledBidirectionalText} = rtlWorkerPlugin;
    if (processBidirectionalText && logicalInput.sections.length === 1) {
        // Bidi doesn't have to be style-aware
        lines = [];
        const untaggedLines =
            processBidirectionalText(logicalInput.toString(),
                determineLineBreaks(logicalInput, spacing, maxWidth, glyphMap, imagePositions, layoutTextSize));
        for (const line of untaggedLines) {
            const taggedLine = new TaggedString();
            taggedLine.text = line;
            taggedLine.sections = logicalInput.sections;
            for (let i = 0; i < line.length; i++) {
                taggedLine.sectionIndex.push(0);
            }
            lines.push(taggedLine);
        }
    } else if (processStyledBidirectionalText) {
        // Need version of mapbox-gl-rtl-text with style support for combining RTL text
        // with formatting
        lines = [];
        const processedLines =
            processStyledBidirectionalText(logicalInput.text,
                logicalInput.sectionIndex,
                determineLineBreaks(logicalInput, spacing, maxWidth, glyphMap, imagePositions, layoutTextSize));
        for (const line of processedLines) {
            const taggedLine = new TaggedString();
            taggedLine.text = line[0];
            taggedLine.sectionIndex = line[1];
            taggedLine.sections = logicalInput.sections;
            lines.push(taggedLine);
        }
    } else {
        lines = breakLines(logicalInput, determineLineBreaks(logicalInput, spacing, maxWidth, glyphMap, imagePositions, layoutTextSize));
    }

    const positionedLines = [];
    const shaping = {
        positionedLines,
        text: logicalInput.toString(),
        top: translate[1],
        bottom: translate[1],
        left: translate[0],
        right: translate[0],
        writingMode,
        iconsInText: false,
        verticalizable: false
    };

    shapeLines(shaping, glyphMap, glyphPositions, imagePositions, lines, lineHeight, textAnchor, textJustify, writingMode, spacing, allowVerticalPlacement, layoutTextSizeThisZoom);
    if (isEmpty(positionedLines)) return false;

    return shaping;
}

// using computed properties due to https://github.com/facebook/flow/issues/380
/* eslint no-useless-computed-key: 0 */

const whitespace: {
    [_: number]: boolean;
} = {
    [0x09]: true, // tab
    [0x0a]: true, // newline
    [0x0b]: true, // vertical tab
    [0x0c]: true, // form feed
    [0x0d]: true, // carriage return
    [0x20]: true, // space
};

const breakable: {
    [_: number]: boolean;
} = {
    [0x0a]: true, // newline
    [0x20]: true, // space
    [0x26]: true, // ampersand
    [0x29]: true, // right parenthesis
    [0x2b]: true, // plus sign
    [0x2d]: true, // hyphen-minus
    [0x2f]: true, // solidus
    [0xad]: true, // soft hyphen
    [0xb7]: true, // middle dot
    [0x200b]: true, // zero-width space
    [0x2010]: true, // hyphen
    [0x2013]: true, // en dash
    [0x2027]: true  // interpunct
    // Many other characters may be reasonable breakpoints
    // Consider "neutral orientation" characters at scriptDetection.charHasNeutralVerticalOrientation
    // See https://github.com/mapbox/mapbox-gl-js/issues/3658
};

// Allow breaks depending on the following character
const breakableBefore: {
    [_: number]: boolean;
} = {
    [0x28]: true, // left parenthesis
};

function getGlyphAdvance(
    codePoint: number,
    section: SectionOptions,
    glyphMap: {
        [_: string]: {
            [_: number]: StyleGlyph;
        };
    },
    imagePositions: {[_: string]: ImagePosition},
    spacing: number,
    layoutTextSize: number
): number {
    if (!section.imageName) {
        const positions = glyphMap[section.fontStack];
        const glyph = positions && positions[codePoint];
        if (!glyph) return 0;
        return glyph.metrics.advance * section.scale + spacing;
    } else {
        const imagePosition = imagePositions[section.imageName];
        if (!imagePosition) return 0;
        return imagePosition.displaySize[0] * section.scale * ONE_EM / layoutTextSize + spacing;
    }
}

function determineAverageLineWidth(logicalInput: TaggedString,
    spacing: number,
    maxWidth: number,
    glyphMap: {
        [_: string]: {
            [_: number]: StyleGlyph;
        };
    },
    imagePositions: {[_: string]: ImagePosition},
    layoutTextSize: number) {
    let totalWidth = 0;

    for (let index = 0; index < logicalInput.length(); index++) {
        const section = logicalInput.getSection(index);
        totalWidth += getGlyphAdvance(logicalInput.getCharCode(index), section, glyphMap, imagePositions, spacing, layoutTextSize);
    }

    const lineCount = Math.max(1, Math.ceil(totalWidth / maxWidth));
    return totalWidth / lineCount;
}

function calculateBadness(lineWidth: number,
    targetWidth: number,
    penalty: number,
    isLastBreak: boolean) {
    const raggedness = Math.pow(lineWidth - targetWidth, 2);
    if (isLastBreak) {
        // Favor finals lines shorter than average over longer than average
        if (lineWidth < targetWidth) {
            return raggedness / 2;
        } else {
            return raggedness * 2;
        }
    }

    return raggedness + Math.abs(penalty) * penalty;
}

function calculatePenalty(codePoint: number, nextCodePoint: number, penalizableIdeographicBreak: boolean) {
    let penalty = 0;
    // Force break on newline
    if (codePoint === 0x0a) {
        penalty -= 10000;
    }
    // Penalize breaks between characters that allow ideographic breaking because
    // they are less preferable than breaks at spaces (or zero width spaces).
    if (penalizableIdeographicBreak) {
        penalty += 150;
    }

    // Penalize open parenthesis at end of line
    if (codePoint === 0x28 || codePoint === 0xff08) {
        penalty += 50;
    }

    // Penalize close parenthesis at beginning of line
    if (nextCodePoint === 0x29 || nextCodePoint === 0xff09) {
        penalty += 50;
    }
    return penalty;
}

type Break = {
    index: number;
    x: number;
    priorBreak: Break;
    badness: number;
};

function evaluateBreak(
    breakIndex: number,
    breakX: number,
    targetWidth: number,
    potentialBreaks: Array<Break>,
    penalty: number,
    isLastBreak: boolean
): Break {
    // We could skip evaluating breaks where the line length (breakX - priorBreak.x) > maxWidth
    //  ...but in fact we allow lines longer than maxWidth (if there's no break points)
    //  ...and when targetWidth and maxWidth are close, strictly enforcing maxWidth can give
    //     more lopsided results.

    let bestPriorBreak: Break = null;
    let bestBreakBadness = calculateBadness(breakX, targetWidth, penalty, isLastBreak);

    for (const potentialBreak of potentialBreaks) {
        const lineWidth = breakX - potentialBreak.x;
        const breakBadness =
            calculateBadness(lineWidth, targetWidth, penalty, isLastBreak) + potentialBreak.badness;
        if (breakBadness <= bestBreakBadness) {
            bestPriorBreak = potentialBreak;
            bestBreakBadness = breakBadness;
        }
    }

    return {
        index: breakIndex,
        x: breakX,
        priorBreak: bestPriorBreak,
        badness: bestBreakBadness
    };
}

function leastBadBreaks(lastLineBreak?: Break | null): Array<number> {
    if (!lastLineBreak) {
        return [];
    }
    return leastBadBreaks(lastLineBreak.priorBreak).concat(lastLineBreak.index);
}

function determineLineBreaks(
    logicalInput: TaggedString,
    spacing: number,
    maxWidth: number,
    glyphMap: {
        [_: string]: {
            [_: number]: StyleGlyph;
        };
    },
    imagePositions: {[_: string]: ImagePosition},
    layoutTextSize: number
): Array<number> {
    if (!logicalInput)
        return [];

    const potentialLineBreaks = [];
    const targetWidth = determineAverageLineWidth(logicalInput, spacing, maxWidth, glyphMap, imagePositions, layoutTextSize);

    const hasServerSuggestedBreakpoints = logicalInput.text.indexOf('\u200b') >= 0;

    let currentX = 0;

    for (let i = 0; i < logicalInput.length(); i++) {
        const section = logicalInput.getSection(i);
        const codePoint = logicalInput.getCharCode(i);
        if (!whitespace[codePoint]) currentX += getGlyphAdvance(codePoint, section, glyphMap, imagePositions, spacing, layoutTextSize);

        // Ideographic characters, spaces, and word-breaking punctuation that often appear without
        // surrounding spaces.
        if ((i < logicalInput.length() - 1)) {
            const ideographicBreak = charAllowsIdeographicBreaking(codePoint);
            if (breakable[codePoint] || ideographicBreak || section.imageName || (i !== logicalInput.length() - 2 && breakableBefore[logicalInput.getCharCode(i + 1)])) {

                potentialLineBreaks.push(
                    evaluateBreak(
                        i + 1,
                        currentX,
                        targetWidth,
                        potentialLineBreaks,
                        calculatePenalty(codePoint, logicalInput.getCharCode(i + 1), ideographicBreak && hasServerSuggestedBreakpoints),
                        false));
            }
        }
    }

    return leastBadBreaks(
        evaluateBreak(
            logicalInput.length(),
            currentX,
            targetWidth,
            potentialLineBreaks,
            0,
            true));
}

function getAnchorAlignment(anchor: SymbolAnchor) {
    let horizontalAlign = 0.5, verticalAlign = 0.5;

    switch (anchor) {
        case 'right':
        case 'top-right':
        case 'bottom-right':
            horizontalAlign = 1;
            break;
        case 'left':
        case 'top-left':
        case 'bottom-left':
            horizontalAlign = 0;
            break;
    }

    switch (anchor) {
        case 'bottom':
        case 'bottom-right':
        case 'bottom-left':
            verticalAlign = 1;
            break;
        case 'top':
        case 'top-right':
        case 'top-left':
            verticalAlign = 0;
            break;
    }

    return {horizontalAlign, verticalAlign};
}

function calculateLineContentSize(
    imagePositions: {[_: string]: ImagePosition},
    line: TaggedString,
    layoutTextSizeFactor: number
): LineShapingSize {
    const maxGlyphSize = line.getMaxScale() * ONE_EM;
    const {maxImageWidth, maxImageHeight} = line.getMaxImageSize(imagePositions);

    const horizontalLineContentHeight = Math.max(maxGlyphSize, maxImageHeight * layoutTextSizeFactor);
    const verticalLineContentWidth = Math.max(maxGlyphSize, maxImageWidth * layoutTextSizeFactor);

    return {verticalLineContentWidth, horizontalLineContentHeight};
}

function getVerticalAlignFactor(
    verticalAlign: VerticalAlign
) {
    switch (verticalAlign) {
        case 'top':
            return 0;
        case 'center':
            return 0.5;
        default:
            return 1;
    }
}

function getRectAndMetrics(
    glyphPosition: GlyphPosition,
    glyphMap: {
        [_: string]: {
            [_: number]: StyleGlyph;
        };
    },
    section: SectionOptions,
    codePoint: number
): GlyphPosition | null {
    if (glyphPosition && glyphPosition.rect) {
        return glyphPosition;
    }

    const glyphs = glyphMap[section.fontStack];
    const glyph = glyphs && glyphs[codePoint];
    if (!glyph) return null;

    const metrics = glyph.metrics;
    return {rect: null, metrics};
}

function isLineVertical(
    writingMode: WritingMode.horizontal | WritingMode.vertical,
    allowVerticalPlacement: boolean,
    codePoint: number
): boolean {
    return !(writingMode === WritingMode.horizontal ||
        // Don't verticalize glyphs that have no upright orientation if vertical placement is disabled.
        (!allowVerticalPlacement && !charHasUprightVerticalOrientation(codePoint)) ||
        // If vertical placement is enabled, don't verticalize glyphs that
        // are from complex text layout script, or whitespaces.
        (allowVerticalPlacement && (whitespace[codePoint] || charInComplexShapingScript(codePoint))));
}

function shapeLines(shaping: Shaping,
    glyphMap: {
        [_: string]: {
            [_: number]: StyleGlyph;
        };
    },
    glyphPositions: {
        [_: string]: {
            [_: number]: GlyphPosition;
        };
    },
    imagePositions: {[_: string]: ImagePosition},
    lines: Array<TaggedString>,
    lineHeight: number,
    textAnchor: SymbolAnchor,
    textJustify: TextJustify,
    writingMode: WritingMode.horizontal | WritingMode.vertical,
    spacing: number,
    allowVerticalPlacement: boolean,
    layoutTextSizeThisZoom: number) {

    let x = 0;
    let y = 0;

    let maxLineLength = 0;
    let maxLineHeight = 0;

    const justify =
        textJustify === 'right' ? 1 :
            textJustify === 'left' ? 0 : 0.5;
    const layoutTextSizeFactor = ONE_EM / layoutTextSizeThisZoom;

    let lineIndex = 0;
    for (const line of lines) {
        line.trim();

        const lineMaxScale = line.getMaxScale();
        const positionedLine = {positionedGlyphs: [], lineOffset: 0};
        shaping.positionedLines[lineIndex] = positionedLine;
        const positionedGlyphs = positionedLine.positionedGlyphs;
        let imageOffset = 0.0;

        if (!line.length()) {
            y += lineHeight; // Still need a line feed after empty line
            ++lineIndex;
            continue;
        }

        const lineShapingSize = calculateLineContentSize(imagePositions, line, layoutTextSizeFactor);

        for (let i = 0; i < line.length(); i++) {
            const section = line.getSection(i);
            const sectionIndex = line.getSectionIndex(i);
            const codePoint = line.getCharCode(i);
            const vertical = isLineVertical(writingMode, allowVerticalPlacement, codePoint);

            let sectionAttributes: ShapingSectionAttributes;

            if (!section.imageName) {
                sectionAttributes = shapeTextSection(section, codePoint, vertical, lineShapingSize, glyphMap, glyphPositions);
                if (!sectionAttributes) continue;
            } else {
                shaping.iconsInText = true;
                // If needed, allow to set scale factor for an image using
                // alias "image-scale" that could be alias for "font-scale"
                // when FormattedSection is an image section.
                section.scale = section.scale * layoutTextSizeFactor;

                sectionAttributes = shapeImageSection(section, vertical, lineMaxScale, lineShapingSize, imagePositions);
                if (!sectionAttributes) continue;
                imageOffset = Math.max(imageOffset, sectionAttributes.imageOffset);
            }

            const {rect, metrics, baselineOffset} = sectionAttributes;
            positionedGlyphs.push({
                glyph: codePoint,
                imageName: section.imageName,
                x,
                y: y + baselineOffset + SHAPING_DEFAULT_OFFSET,
                vertical,
                scale: section.scale,
                fontStack: section.fontStack,
                sectionIndex,
                metrics,
                rect
            });

            if (!vertical) {
                x += metrics.advance * section.scale + spacing;
            } else {
                shaping.verticalizable = true;
                const verticalAdvance = section.imageName ? metrics.advance : ONE_EM;
                x += verticalAdvance * section.scale + spacing;
            }
        }

        // Only justify if we placed at least one glyph
        if (positionedGlyphs.length !== 0) {
            const lineLength = x - spacing;
            maxLineLength = Math.max(lineLength, maxLineLength);
            justifyLine(positionedGlyphs, 0, positionedGlyphs.length - 1, justify);
        }

        x = 0;
        const maxLineOffset = (lineMaxScale - 1) * ONE_EM;
        positionedLine.lineOffset = Math.max(imageOffset, maxLineOffset);
        const currentLineHeight = lineHeight * lineMaxScale + imageOffset;
        y += currentLineHeight;
        maxLineHeight = Math.max(currentLineHeight, maxLineHeight);
        ++lineIndex;
    }

    // Calculate the bounding box and justify / align text block.
    const {horizontalAlign, verticalAlign} = getAnchorAlignment(textAnchor);
    align(shaping.positionedLines, justify, horizontalAlign, verticalAlign, maxLineLength, maxLineHeight, lineHeight, y, lines.length);

    // Calculate the bounding box
    // shaping.top & shaping.left already include text offset (text-radial-offset or text-offset)
    shaping.top += -verticalAlign * y;
    shaping.bottom = shaping.top + y;
    shaping.left += -horizontalAlign * maxLineLength;
    shaping.right = shaping.left + maxLineLength;
}

function shapeTextSection(
    section: SectionOptions,
    codePoint: number,
    vertical: boolean,
    lineShapingSize: LineShapingSize,
    glyphMap: {
        [_: string]: {
            [_: number]: StyleGlyph;
        };
    },
    glyphPositions: {
        [_: string]: {
            [_: number]: GlyphPosition;
        };
    },
): ShapingSectionAttributes | null {
    const positions = glyphPositions[section.fontStack];
    const glyphPosition = positions && positions[codePoint];

    const rectAndMetrics = getRectAndMetrics(glyphPosition, glyphMap, section, codePoint);

    if (rectAndMetrics === null) return null;

    let baselineOffset: number;
    if (vertical) {
        baselineOffset = lineShapingSize.verticalLineContentWidth - section.scale * ONE_EM;
    } else {
        const verticalAlignFactor = getVerticalAlignFactor(section.verticalAlign);
        baselineOffset = (lineShapingSize.horizontalLineContentHeight - section.scale * ONE_EM) * verticalAlignFactor;
    }

    return {
        rect: rectAndMetrics.rect,
        metrics: rectAndMetrics.metrics,
        baselineOffset
    };
}

function shapeImageSection(
    section: SectionOptions,
    vertical: boolean,
    lineMaxScale: number,
    lineShapingSize: LineShapingSize,
    imagePositions: {[_: string]: ImagePosition},
): ShapingSectionAttributes | null {
    const imagePosition = imagePositions[section.imageName];
    if (!imagePosition) return null;
    const rect = imagePosition.paddedRect;
    const size = imagePosition.displaySize;

    const metrics = {width: size[0],
        height: size[1],
        left: IMAGE_PADDING,
        top: -GLYPH_PBF_BORDER,
        advance: vertical ? size[1] : size[0]};

    let baselineOffset: number;
    if (vertical) {
        baselineOffset = lineShapingSize.verticalLineContentWidth - size[1] * section.scale;
    } else {
        const verticalAlignFactor = getVerticalAlignFactor(section.verticalAlign);
        baselineOffset = (lineShapingSize.horizontalLineContentHeight - size[1] * section.scale) * verticalAlignFactor;
    }

    // Difference between height of an image and one EM at max line scale.
    // Pushes current line down if an image size is over 1 EM at max line scale.
    const imageOffset = (vertical ? size[0] : size[1]) * section.scale - ONE_EM * lineMaxScale;
    
    return {rect, metrics, baselineOffset, imageOffset};
}

// justify right = 1, left = 0, center = 0.5
function justifyLine(positionedGlyphs: Array<PositionedGlyph>,
    start: number,
    end: number,
    justify: 1 | 0 | 0.5) {
    if (justify === 0)
        return;

    const lastPositionedGlyph = positionedGlyphs[end];
    const lastAdvance = lastPositionedGlyph.metrics.advance * lastPositionedGlyph.scale;
    const lineIndent = (positionedGlyphs[end].x + lastAdvance) * justify;

    for (let j = start; j <= end; j++) {
        positionedGlyphs[j].x -= lineIndent;
    }
}

/**
 * Aligns the lines based on horizontal and vertical alignment.
 */
function align(positionedLines: Array<PositionedLine>,
    justify: number,
    horizontalAlign: number,
    verticalAlign: number,
    maxLineLength: number,
    maxLineHeight: number,
    lineHeight: number,
    blockHeight: number,
    lineCount: number) {
    const shiftX = (justify - horizontalAlign) * maxLineLength;
    let shiftY = 0;

    if (maxLineHeight !== lineHeight) {
        shiftY = -blockHeight * verticalAlign - SHAPING_DEFAULT_OFFSET;
    } else {
        shiftY = -verticalAlign * lineCount * lineHeight + 0.5 * lineHeight;
    }

    for (const line of positionedLines) {
        for (const positionedGlyph of line.positionedGlyphs) {
            positionedGlyph.x += shiftX;
            positionedGlyph.y += shiftY;
        }
    }
}

export type PositionedIcon = {
    image: ImagePosition;
    top: number;
    bottom: number;
    left: number;
    right: number;
    collisionPadding?: [number, number, number, number];
};

function shapeIcon(
    image: ImagePosition,
    iconOffset: [number, number],
    iconAnchor: SymbolAnchor
): PositionedIcon {
    const {horizontalAlign, verticalAlign} = getAnchorAlignment(iconAnchor);
    const dx = iconOffset[0];
    const dy = iconOffset[1];
    const x1 = dx - image.displaySize[0] * horizontalAlign;
    const x2 = x1 + image.displaySize[0];
    const y1 = dy - image.displaySize[1] * verticalAlign;
    const y2 = y1 + image.displaySize[1];
    return {image, top: y1, bottom: y2, left: x1, right: x2};
}

export interface Box {
    x1: number;
    y1: number;
    x2: number;
    y2: number;
}

/**
 * Called after a PositionedIcon has already been run through fitIconToText,
 * but needs further adjustment to apply textFitWidth and textFitHeight.
 * @param shapedIcon - The icon that will be adjusted.
 * @returns Extents of the shapedIcon with text fit adjustments if necessary.
 */
function applyTextFit(shapedIcon: PositionedIcon): Box {
    // Assume shapedIcon.image is set or this wouldn't be called.
    // Size of the icon after it was adjusted using stretchX and Y
    let iconLeft = shapedIcon.left;
    let iconTop = shapedIcon.top;
    let iconWidth = shapedIcon.right - iconLeft;
    let iconHeight = shapedIcon.bottom - iconTop;
    // Size of the original content area
    const contentWidth = shapedIcon.image.content[2] - shapedIcon.image.content[0];
    const contentHeight = shapedIcon.image.content[3] - shapedIcon.image.content[1];
    const textFitWidth = shapedIcon.image.textFitWidth ?? TextFit.stretchOrShrink;
    const textFitHeight = shapedIcon.image.textFitHeight ?? TextFit.stretchOrShrink;
    const contentAspectRatio = contentWidth / contentHeight;
    // Scale to the proportional axis first note that height takes precedence if
    // both axes are set to proportional.
    if (textFitHeight === TextFit.proportional) {
        if ((textFitWidth === TextFit.stretchOnly && iconWidth / iconHeight < contentAspectRatio) || textFitWidth === TextFit.proportional) {
            // Push the width of the icon back out to match the content aspect ratio
            const newIconWidth = Math.ceil(iconHeight * contentAspectRatio);
            iconLeft *= newIconWidth / iconWidth;
            iconWidth = newIconWidth;
        }
    } else if (textFitWidth === TextFit.proportional) {
        if (textFitHeight === TextFit.stretchOnly && contentAspectRatio !== 0 && iconWidth / iconHeight > contentAspectRatio) {
            // Push the height of the icon back out to match the content aspect ratio
            const newIconHeight = Math.ceil(iconWidth / contentAspectRatio);
            iconTop *= newIconHeight / iconHeight;
            iconHeight = newIconHeight;
        }
    } else {
        // If neither textFitHeight nor textFitWidth are proportional then
        // there is no effect since the content rectangle should be precisely
        // matched to the content
    }
    return {x1: iconLeft, y1: iconTop, x2: iconLeft + iconWidth, y2: iconTop + iconHeight};
}

function fitIconToText(
    shapedIcon: PositionedIcon,
    shapedText: Shaping,
    textFit: string,
    padding: [number, number, number, number],
    iconOffset: [number, number],
    fontScale: number
): PositionedIcon {

    const image = shapedIcon.image;

    let collisionPadding;
    if (image.content) {
        const content = image.content;
        const pixelRatio = image.pixelRatio || 1;
        collisionPadding = [
            content[0] / pixelRatio,
            content[1] / pixelRatio,
            image.displaySize[0] - content[2] / pixelRatio,
            image.displaySize[1] - content[3] / pixelRatio
        ];
    }

    // We don't respect the icon-anchor, because icon-text-fit is set. Instead,
    // the icon will be centered on the text, then stretched in the given
    // dimensions.

    const textLeft = shapedText.left * fontScale;
    const textRight = shapedText.right * fontScale;

    let top, right, bottom, left;
    if (textFit === 'width' || textFit === 'both') {
        // Stretched horizontally to the text width
        left = iconOffset[0] + textLeft - padding[3];
        right = iconOffset[0] + textRight + padding[1];
    } else {
        // Centered on the text
        left = iconOffset[0] + (textLeft + textRight - image.displaySize[0]) / 2;
        right = left + image.displaySize[0];
    }

    const textTop = shapedText.top * fontScale;
    const textBottom = shapedText.bottom * fontScale;
    if (textFit === 'height' || textFit === 'both') {
        // Stretched vertically to the text height
        top = iconOffset[1] + textTop - padding[0];
        bottom = iconOffset[1] + textBottom + padding[2];
    } else {
        // Centered on the text
        top = iconOffset[1] + (textTop + textBottom - image.displaySize[1]) / 2;
        bottom = top + image.displaySize[1];
    }

    return {image, top, right, bottom, left, collisionPadding};
}
