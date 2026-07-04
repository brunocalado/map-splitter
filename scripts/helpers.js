/*!
 * Map Splitter
 * Copyright (c) 2026 https://github.com/brunocalado
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License version 3.
 */

/**
 * Shared geometry helpers used across the split editor and the data-splitting logic.
 * All rectangles are plain objects of the form {x, y, width, height} in canvas coordinates.
 */

/**
 * Determine which part interval a coordinate belongs to, given the ascending list of part edges.
 * Values that fall exactly on an interior cut line resolve to the lower index (left/top scene),
 * which implements the deterministic tiebreaker required by the splitting rules.
 * Values outside the edge range are clamped to the first/last interval, so documents placed in
 * the scene padding are still assigned to the nearest part.
 * @param {number} value            The coordinate to classify.
 * @param {number[]} edges          Ascending edge coordinates (length = parts + 1).
 * @returns {number}                The zero-based part interval index.
 */
export function partIndexForCoord(value, edges) {
  for (let i = 0; i < edges.length - 2; i++) {
    if (value <= edges[i + 1]) return i;
  }
  return edges.length - 2;
}

/**
 * Test whether two rectangles overlap with positive area (touching edges do not count).
 * Strict inequality keeps documents that merely abut a cut line from being duplicated into
 * the neighboring scene where they would occupy zero visible area.
 * @param {{x: number, y: number, width: number, height: number}} a  First rectangle.
 * @param {{x: number, y: number, width: number, height: number}} b  Second rectangle.
 * @returns {boolean}               True when the rectangles share a region of positive area.
 */
export function rectsIntersect(a, b) {
  return (a.x < b.x + b.width) && (b.x < a.x + a.width)
    && (a.y < b.y + b.height) && (b.y < a.y + a.height);
}

/**
 * Compute the axis-aligned bounding box of a rectangle rotated around its own center.
 * Matches how Foundry rotates Tiles, Drawings, and Region rectangle/ellipse shapes.
 * @param {number} x                Top-left x of the unrotated rectangle.
 * @param {number} y                Top-left y of the unrotated rectangle.
 * @param {number} width            Rectangle width.
 * @param {number} height           Rectangle height.
 * @param {number} [rotation=0]     Rotation in degrees.
 * @returns {{x: number, y: number, width: number, height: number}} The enclosing bounding box.
 */
export function rotatedBounds(x, y, width, height, rotation = 0) {
  if (!rotation) return {x, y, width, height};
  const rad = Math.toRadians(rotation);
  const cos = Math.abs(Math.cos(rad));
  const sin = Math.abs(Math.sin(rad));
  const hw = ((width * cos) + (height * sin)) / 2;
  const hh = ((width * sin) + (height * cos)) / 2;
  const cx = x + (width / 2);
  const cy = y + (height / 2);
  return {x: cx - hw, y: cy - hh, width: hw * 2, height: hh * 2};
}

/**
 * Clip a line segment against a rectangle using the Liang-Barsky algorithm (inclusive bounds).
 * @param {number} x1               Segment start x.
 * @param {number} y1               Segment start y.
 * @param {number} x2               Segment end x.
 * @param {number} y2               Segment end y.
 * @param {{x: number, y: number, width: number, height: number}} rect  The clip rectangle.
 * @returns {{x1: number, y1: number, x2: number, y2: number}|null} The clipped segment, or null
 *   when the segment lies entirely outside the rectangle. The result may be degenerate
 *   (zero length) when the segment only touches the rectangle boundary.
 */
export function clipSegmentToRect(x1, y1, x2, y2, rect) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  let t0 = 0;
  let t1 = 1;
  const p = [-dx, dx, -dy, dy];
  const q = [x1 - rect.x, rect.x + rect.width - x1, y1 - rect.y, rect.y + rect.height - y1];
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) {
      if (q[i] < 0) return null;
      continue;
    }
    const r = q[i] / p[i];
    if (p[i] < 0) {
      if (r > t1) return null;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return null;
      if (r < t1) t1 = r;
    }
  }
  return {
    x1: x1 + (t0 * dx),
    y1: y1 + (t0 * dy),
    x2: x1 + (t1 * dx),
    y2: y1 + (t1 * dy)
  };
}

/**
 * Test whether a circle intersects a rectangle (inclusive: touching counts as intersecting).
 * Used to decide whether a light/sound source still affects a generated scene even when its
 * origin point lies outside that scene's part rectangle.
 * @param {number} cx               Circle center x.
 * @param {number} cy               Circle center y.
 * @param {number} r                Circle radius.
 * @param {{x: number, y: number, width: number, height: number}} rect  The rectangle.
 * @returns {boolean}               True when the circle and rectangle intersect.
 */
export function circleIntersectsRect(cx, cy, r, rect) {
  const nx = Math.clamp(cx, rect.x, rect.x + rect.width);
  const ny = Math.clamp(cy, rect.y, rect.y + rect.height);
  const dx = cx - nx;
  const dy = cy - ny;
  return ((dx * dx) + (dy * dy)) <= (r * r);
}
