/*!
 * Map Splitter
 * Copyright (c) 2026 https://github.com/brunocalado
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License version 3.
 */

/**
 * Data-splitting logic: given a source scene and grid-aligned cut coordinates, build the full
 * creation data for every generated part scene, including the mirrored teleport border regions
 * that link adjacent parts.
 *
 * All computations run on plain objects obtained from Scene#toObject, so this file performs no
 * database operations itself.
 */

import { FLAG_INSETS, FLAG_NEIGHBORS, MODULE_ID, OPPOSITE_SIDE, OVERLAP_SQUARES, TELEPORT_REGION_COLOR } from "./constants.js";
import { circleIntersectsRect, clipSegmentToRect, partIndexForCoord, rectsIntersect, rotatedBounds } from "./helpers.js";

/**
 * @typedef {object} ScenePart
 * @property {number} row                      Zero-based row index.
 * @property {number} col                      Zero-based column index.
 * @property {{x: number, y: number, width: number, height: number}} rect      Logical part
 *   rectangle in source-canvas coordinates, bounded by the snapped cut lines.
 * @property {{x: number, y: number, width: number, height: number}} cropRect  Like rect, but
 *   expanded by the overlap buffer on every edge that faces an adjacent part; defines the
 *   generated scene rectangle and the background image crop.
 * @property {{x: number, y: number, width: number, height: number}} clipRect  Like cropRect, but
 *   extended into the source scene padding on outer edges so padding-area documents survive.
 * @property {{dx: number, dy: number}} delta  Translation from source-canvas coordinates to the
 *   generated scene's canvas coordinates.
 * @property {object} dims                     SceneDimensions of the generated scene.
 * @property {object} data                     The Scene creation data being assembled.
 */

/**
 * Build the creation data for all part scenes, in row-major order.
 * @param {foundry.documents.Scene} scene  The source scene document.
 * @param {number[]} xs                    Ascending x edges in canvas coordinates, including the
 *                                         scene rectangle bounds (length = columns + 1).
 * @param {number[]} ys                    Ascending y edges (length = rows + 1).
 * @param {string[]} imagePaths            Row-major server paths of the sliced background images.
 * @param {string|null} folderId           Id of the Scene folder every generated scene is filed in.
 * @returns {object[]}                     Scene creation data objects, row-major.
 */
export function buildPartScenes(scene, xs, ys, imagePaths, folderId = null) {
  const src = scene.toObject();
  const dims = scene.dimensions;
  const level = src.levels?.[0];
  if (!level) throw new Error("The source scene has no level data. Map Splitter requires a Foundry v14 scene with exactly one level.");

  const rows = ys.length - 1;
  const cols = xs.length - 1;
  const parts = createParts(src, level, dims, xs, ys, imagePaths, scene.id, folderId);
  const partAt = (x, y) => parts[(partIndexForCoord(y, ys) * cols) + partIndexForCoord(x, xs)];
  recordNeighbors(parts, rows, cols);

  // FIXME: Radius conversion assumes the default relation between grid size and grid distance.
  // Good enough because the generated scenes copy the source grid verbatim.
  const unitPx = dims.size / (src.grid?.distance || 1);

  assignWalls(src.walls ?? [], parts);
  assignRadiusDocs(src.lights ?? [], parts, partAt, "lights",
    doc => Math.max(doc.config?.dim ?? 0, doc.config?.bright ?? 0, 0) * unitPx);
  assignRadiusDocs(src.sounds ?? [], parts, partAt, "sounds",
    doc => Math.max(doc.radius ?? 0, 0) * unitPx);
  assignAnchorDocs(src.notes ?? [], parts, partAt, "notes");
  duplicateByBounds(src.tiles ?? [], parts, partAt, "tiles",
    doc => rotatedBounds(doc.x, doc.y, doc.width ?? 0, doc.height ?? 0, doc.rotation ?? 0));
  duplicateByBounds(src.drawings ?? [], parts, partAt, "drawings",
    doc => rotatedBounds(doc.x, doc.y, doc.shape?.width ?? 0, doc.shape?.height ?? 0, doc.rotation ?? 0));
  duplicateByBounds(src.regions ?? [], parts, partAt, "regions", regionBounds, translateRegion);
  linkAdjacentParts(parts, rows, cols, dims.size, level);

  return parts.map(part => part.data);
}

/* -------------------------------------------- */
/*  Part construction                           */
/* -------------------------------------------- */

/**
 * Compute the crop rectangle of one part: its logical rectangle expanded by the overlap buffer
 * on every edge that faces an adjacent part, clamped to the source scene rectangle.
 * Shared by the image slicer and the scene builder so the sliced background always maps 1:1 onto
 * the generated scene rectangle.
 * @param {number} row           Zero-based row index.
 * @param {number} col           Zero-based column index.
 * @param {number[]} xs          Ascending x edges in canvas coordinates (length = columns + 1).
 * @param {number[]} ys          Ascending y edges (length = rows + 1).
 * @param {object} dims          Source SceneDimensions.
 * @param {number} overlapPx     Overlap buffer depth in pixels.
 * @returns {{x: number, y: number, width: number, height: number}}  The crop rectangle in
 *   source-canvas coordinates.
 */
export function partCropRect(row, col, xs, ys, dims, overlapPx) {
  const rows = ys.length - 1;
  const cols = xs.length - 1;
  const x0 = Math.max(dims.sceneX, xs[col] - (col > 0 ? overlapPx : 0));
  const y0 = Math.max(dims.sceneY, ys[row] - (row > 0 ? overlapPx : 0));
  const x1 = Math.min(dims.sceneX + dims.sceneWidth, xs[col + 1] + (col < cols - 1 ? overlapPx : 0));
  const y1 = Math.min(dims.sceneY + dims.sceneHeight, ys[row + 1] + (row < rows - 1 ? overlapPx : 0));
  return {x: x0, y: y0, width: x1 - x0, height: y1 - y0};
}

/**
 * Create the part descriptors with their base scene data and coordinate deltas.
 * @param {object} src           Source scene data (Scene#toObject).
 * @param {object} level         The single source level data.
 * @param {object} dims          Source SceneDimensions.
 * @param {number[]} xs          Ascending x edges.
 * @param {number[]} ys          Ascending y edges.
 * @param {string[]} imagePaths  Row-major sliced image paths.
 * @param {string} sourceSceneId Id of the source scene, recorded in flags.
 * @param {string|null} folderId Id of the Scene folder every generated scene is filed in.
 * @returns {ScenePart[]}        The part descriptors, row-major.
 */
function createParts(src, level, dims, xs, ys, imagePaths, sourceSceneId, folderId) {
  const rows = ys.length - 1;
  const cols = xs.length - 1;
  const overlapPx = OVERLAP_SQUARES * dims.size;
  const parts = [];
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      const rect = {x: xs[j], y: ys[i], width: xs[j + 1] - xs[j], height: ys[i + 1] - ys[i]};
      const cropRect = partCropRect(i, j, xs, ys, dims, overlapPx);
      // Buffer depth actually applied on each side (clamping may shrink it near the source scene
      // bounds); recorded in flags so the border tools can locate the logical borders later.
      const insets = {
        left: rect.x - cropRect.x,
        top: rect.y - cropRect.y,
        right: (cropRect.x + cropRect.width) - (rect.x + rect.width),
        bottom: (cropRect.y + cropRect.height) - (rect.y + rect.height)
      };
      // Interior edges clip at the overlap buffer so buffer-area documents are duplicated in;
      // outer-edge parts also claim the source padding area so walls/lights placed there
      // are not silently dropped.
      const clipRect = {
        x: j === 0 ? 0 : cropRect.x,
        y: i === 0 ? 0 : cropRect.y
      };
      clipRect.width = (j === cols - 1 ? dims.width : cropRect.x + cropRect.width) - clipRect.x;
      clipRect.height = (i === rows - 1 ? dims.height : cropRect.y + cropRect.height) - clipRect.y;

      const data = buildBaseSceneData(src, level, cropRect, insets, i, j, imagePaths[(i * cols) + j], sourceSceneId, folderId);
      // A transient, unsaved document is enough to resolve the padding math of the new scene.
      const tmp = new (CONFIG.Scene.documentClass)({
        name: data.name,
        width: cropRect.width,
        height: cropRect.height,
        padding: data.padding,
        grid: foundry.utils.deepClone(data.grid)
      });
      const partDims = tmp.dimensions;
      const delta = {dx: partDims.sceneX - cropRect.x, dy: partDims.sceneY - cropRect.y};
      parts.push({row: i, col: j, rect, cropRect, clipRect, delta, dims: partDims, data});
    }
  }
  return parts;
}

/**
 * Build the non-embedded portion of a generated scene's creation data.
 * The single source level is cloned with its `_id` preserved so that level references
 * (Region#levels, Scene#initialLevel) stay valid, and its background swapped for the sliced image.
 * @param {object} src           Source scene data (Scene#toObject).
 * @param {object} level         The single source level data.
 * @param {{x: number, y: number, width: number, height: number}} cropRect  The part crop
 *                               rectangle, including the overlap buffer.
 * @param {{left: number, top: number, right: number, bottom: number}} insets  Applied overlap
 *                               buffer depth per side, recorded in flags for the border tools.
 * @param {number} row           Zero-based row index.
 * @param {number} col           Zero-based column index.
 * @param {string} imagePath     Server path of the sliced background image.
 * @param {string} sourceSceneId Id of the source scene, recorded in flags.
 * @param {string|null} folderId Id of the Scene folder the generated scene is filed in.
 * @returns {object}             Scene creation data with empty embedded collections.
 */
function buildBaseSceneData(src, level, cropRect, insets, row, col, imagePath, sourceSceneId, folderId) {
  const levelData = foundry.utils.deepClone(level);
  levelData.background = {...levelData.background, src: imagePath};
  // Foregrounds and per-level fog images span the whole original map and cannot be reused as-is.
  levelData.foreground = {...levelData.foreground, src: null};
  levelData.fog = {src: null};
  // The sliced image maps 1:1 onto the new scene rectangle, so texture adjustments are reset.
  levelData.textures = {
    ...levelData.textures,
    offsetX: 0, offsetY: 0, scaleX: 1, scaleY: 1, rotation: 0, fit: "fill"
  };
  return {
    _id: foundry.utils.randomID(),
    name: `${src.name} ${row + 1}-${col + 1}`,
    navigation: false,
    navName: "",
    thumb: null,
    width: cropRect.width,
    height: cropRect.height,
    padding: src.padding,
    shiftX: 0,
    shiftY: 0,
    initial: {x: null, y: null, scale: null},
    initialLevel: levelData._id,
    grid: foundry.utils.deepClone(src.grid),
    tokenVision: src.tokenVision,
    fog: foundry.utils.deepClone(src.fog),
    environment: foundry.utils.deepClone(src.environment),
    transition: foundry.utils.deepClone(src.transition),
    levels: [levelData],
    tokens: [],
    walls: [],
    lights: [],
    sounds: [],
    notes: [],
    tiles: [],
    drawings: [],
    regions: [],
    playlist: src.playlist,
    playlistSound: src.playlistSound,
    journal: src.journal,
    journalEntryPage: src.journalEntryPage,
    weather: src.weather,
    folder: folderId ?? src.folder,
    ownership: foundry.utils.deepClone(src.ownership),
    flags: {[MODULE_ID]: {sourceScene: sourceSceneId, row: row + 1, col: col + 1, [FLAG_INSETS]: insets}}
  };
}

/**
 * Record each part's adjacent generated scene ids in its scene flags.
 * The border tools rely on this map both to detect module-generated scenes and to resolve which
 * scene a border crossing must link to (e.g. on "mega-dungeon-1-1" only "mega-dungeon-1-2" and
 * "mega-dungeon-2-1" are reachable).
 * @param {ScenePart[]} parts    The part descriptors, row-major.
 * @param {number} rows          Number of rows.
 * @param {number} cols          Number of columns.
 */
function recordNeighbors(parts, rows, cols) {
  const idAt = (r, c) => ((r < 0) || (c < 0) || (r >= rows) || (c >= cols))
    ? null
    : parts[(r * cols) + c].data._id;
  for (const part of parts) {
    part.data.flags[MODULE_ID][FLAG_NEIGHBORS] = {
      north: idAt(part.row - 1, part.col),
      south: idAt(part.row + 1, part.col),
      west: idAt(part.row, part.col - 1),
      east: idAt(part.row, part.col + 1)
    };
  }
}

/* -------------------------------------------- */
/*  Document assignment                         */
/* -------------------------------------------- */

/**
 * Clone a document's data and translate its x/y anchor into a part's coordinate space.
 * @param {object} doc                       Source document data.
 * @param {{dx: number, dy: number}} delta   The part's coordinate translation.
 * @returns {object}                         The translated clone.
 */
function cloneTranslated(doc, delta) {
  const dup = foundry.utils.deepClone(doc);
  dup.x += delta.dx;
  dup.y += delta.dy;
  return dup;
}

/**
 * Assign walls and doors to parts.
 * Standard walls are geometrically clipped to each part rectangle; segments lying exactly on an
 * interior cut line belong to the left/top part only (deterministic tiebreaker). Doors are never
 * sliced — a sliced door would be a non-interactable half-door — so any door touching a part with
 * positive length is duplicated into it whole.
 * @param {object[]} walls       Source wall data.
 * @param {ScenePart[]} parts    The part descriptors.
 */
function assignWalls(walls, parts) {
  for (const wall of walls) {
    const [x1, y1, x2, y2] = wall.c;
    const isDoor = (wall.door ?? 0) > 0;
    for (const part of parts) {
      const clipped = clipSegmentToRect(x1, y1, x2, y2, part.clipRect);
      if (!clipped) continue;
      const length = Math.hypot(clipped.x2 - clipped.x1, clipped.y2 - clipped.y1);
      if (length <= 0) continue;
      const dup = foundry.utils.deepClone(wall);
      if (isDoor) {
        dup.c = [x1 + part.delta.dx, y1 + part.delta.dy, x2 + part.delta.dx, y2 + part.delta.dy];
      } else {
        // Segments collinear with the interior clip boundary (the far edge of the overlap
        // buffer) are owned by the neighboring left/top part, avoiding stray edge walls.
        const onInteriorLeft = clipped.x1 === clipped.x2 && clipped.x1 === part.clipRect.x && part.col > 0;
        const onInteriorTop = clipped.y1 === clipped.y2 && clipped.y1 === part.clipRect.y && part.row > 0;
        if (onInteriorLeft || onInteriorTop) continue;
        dup.c = [
          clipped.x1 + part.delta.dx, clipped.y1 + part.delta.dy,
          clipped.x2 + part.delta.dx, clipped.y2 + part.delta.dy
        ];
      }
      part.data.walls.push(dup);
    }
  }
}

/**
 * Assign radius-bearing point documents (lights, sounds) to parts.
 * The document always lands in its anchor part; it is additionally duplicated into every part its
 * effect radius reaches, even when the source point ends up outside that part (possibly at
 * negative local coordinates), preserving cross-border illumination and audio.
 * @param {object[]} docs                      Source document data.
 * @param {ScenePart[]} parts                  The part descriptors.
 * @param {function(number, number): ScenePart} partAt  Resolver for the anchor part.
 * @param {string} key                         The embedded collection key on the scene data.
 * @param {function(object): number} getRadius Effect radius in canvas pixels.
 */
function assignRadiusDocs(docs, parts, partAt, key, getRadius) {
  for (const doc of docs) {
    const radius = getRadius(doc);
    const anchorPart = partAt(doc.x, doc.y);
    for (const part of parts) {
      const isAnchor = part === anchorPart;
      const affects = radius > 0 && circleIntersectsRect(doc.x, doc.y, radius, part.clipRect);
      if (!isAnchor && !affects) continue;
      part.data[key].push(cloneTranslated(doc, part.delta));
    }
  }
}

/**
 * Assign pure point documents (notes) to the single part containing their anchor.
 * @param {object[]} docs                      Source document data.
 * @param {ScenePart[]} parts                  The part descriptors.
 * @param {function(number, number): ScenePart} partAt  Resolver for the anchor part.
 * @param {string} key                         The embedded collection key on the scene data.
 */
function assignAnchorDocs(docs, parts, partAt, key) {
  for (const doc of docs) {
    const part = partAt(doc.x, doc.y);
    part.data[key].push(cloneTranslated(doc, part.delta));
  }
}

/**
 * Duplicate area documents (tiles, drawings, regions) into every part their bounding box overlaps
 * with positive area. Tile/drawing images are intentionally never cropped — the whole document is
 * repositioned instead, which may produce negative local coordinates.
 * Degenerate (zero-area) bounds fall back to the anchor-point rule so nothing is ever lost.
 * @param {object[]} docs                      Source document data.
 * @param {ScenePart[]} parts                  The part descriptors.
 * @param {function(number, number): ScenePart} partAt  Resolver for the fallback anchor part.
 * @param {string} key                         The embedded collection key on the scene data.
 * @param {function(object): (object|null)} getBounds   Bounding-box extractor.
 * @param {function(object, {dx: number, dy: number}): object} [translate]  Clone-and-translate
 *   strategy; defaults to simple x/y translation.
 */
function duplicateByBounds(docs, parts, partAt, key, getBounds, translate = cloneTranslated) {
  for (const doc of docs) {
    const bounds = getBounds(doc);
    if (!bounds) continue;
    let placed = false;
    for (const part of parts) {
      if (!rectsIntersect(bounds, part.clipRect)) continue;
      part.data[key].push(translate(doc, part.delta));
      placed = true;
    }
    if (!placed) {
      const part = partAt(bounds.x, bounds.y);
      part.data[key].push(translate(doc, part.delta));
    }
  }
}

/* -------------------------------------------- */
/*  Region geometry                             */
/* -------------------------------------------- */

/**
 * Compute the union bounding box of all shapes of a region.
 * @param {object} region        Source region data.
 * @returns {{x: number, y: number, width: number, height: number}|null} The bounding box, or null
 *   when the region has no resolvable shapes.
 */
function regionBounds(region) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const shape of region.shapes ?? []) {
    let b;
    switch (shape.type) {
      case "polygon": {
        const points = shape.points ?? [];
        let px0 = Infinity;
        let py0 = Infinity;
        let px1 = -Infinity;
        let py1 = -Infinity;
        for (let k = 0; k < points.length - 1; k += 2) {
          px0 = Math.min(px0, points[k]);
          px1 = Math.max(px1, points[k]);
          py0 = Math.min(py0, points[k + 1]);
          py1 = Math.max(py1, points[k + 1]);
        }
        if (!Number.isFinite(px0)) continue;
        b = {x: px0, y: py0, width: px1 - px0, height: py1 - py0};
        break;
      }
      case "circle":
        b = {x: shape.x - shape.radius, y: shape.y - shape.radius, width: shape.radius * 2, height: shape.radius * 2};
        break;
      case "ellipse":
        b = rotatedBounds(shape.x - shape.radiusX, shape.y - shape.radiusY,
          shape.radiusX * 2, shape.radiusY * 2, shape.rotation ?? 0);
        break;
      default: // rectangle
        b = rotatedBounds(shape.x, shape.y, shape.width ?? 0, shape.height ?? 0, shape.rotation ?? 0);
    }
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.width);
    maxY = Math.max(maxY, b.y + b.height);
  }
  if (!Number.isFinite(minX)) return null;
  return {x: minX, y: minY, width: maxX - minX, height: maxY - minY};
}

/**
 * Clone a region and translate every shape into a part's coordinate space.
 * @param {object} region                    Source region data.
 * @param {{dx: number, dy: number}} delta   The part's coordinate translation.
 * @returns {object}                         The translated clone.
 */
function translateRegion(region, delta) {
  const dup = foundry.utils.deepClone(region);
  dup.shapes = (dup.shapes ?? []).map(shape => {
    if (shape.type === "polygon") {
      shape.points = (shape.points ?? []).map((v, k) => (k % 2 === 0) ? v + delta.dx : v + delta.dy);
    } else {
      shape.x += delta.dx;
      shape.y += delta.dy;
    }
    return shape;
  });
  return dup;
}

/* -------------------------------------------- */
/*  Teleport border regions                     */
/* -------------------------------------------- */

/**
 * Create the teleport crossings along every shared border of adjacent parts.
 * Each border is populated with one single-square region per grid cell (not one big strip): the
 * GM curates crossings by deleting/re-adding individual squares with the border tools, and
 * whole-region create/delete operations are far more robust than in-place shape surgery.
 * @param {ScenePart[]} parts    The part descriptors, row-major.
 * @param {number} rows          Number of rows.
 * @param {number} cols          Number of columns.
 * @param {number} gridSize      Grid size in pixels; region squares are one grid unit thick.
 * @param {object} level         The single source level data (for elevation and level references).
 */
function linkAdjacentParts(parts, rows, cols, gridSize, level) {
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      const part = parts[(i * cols) + j];
      if (j < cols - 1) linkPartPair(part, parts[(i * cols) + j + 1], "east", gridSize, level);
      if (i < rows - 1) linkPartPair(part, parts[((i + 1) * cols) + j], "south", gridSize, level);
    }
  }
}

/**
 * Create the teleport crossings between two adjacent parts, one bidirectional crossing per border
 * grid cell. Each crossing is made of two independent one-way region pairs (a→b and b→a), so
 * departures sit at each scene's physical edge while arrivals stay passive. Crossings cover the
 * whole physical edge — including the overlap-buffer corners — so no border cell is left without
 * a crossing. Depths are clamped for scenes thinner than one grid unit; a trailing partial grid
 * cell yields a final shorter square on both sides alike.
 * @param {ScenePart} a          The left (east link) or top (south link) part.
 * @param {ScenePart} b          The right or bottom neighbor.
 * @param {"east"|"south"} side  Which border of part `a` faces part `b`.
 * @param {number} gridSize      Grid size in pixels.
 * @param {object} level         The single source level data.
 */
function linkPartPair(a, b, side, gridSize, level) {
  const vertical = side === "east";
  // Adjacent parts share their perpendicular crop range (row/column buffer expansions are
  // identical across a row/column), so both physical border spans cover the same map interval
  // and the cells of the two directions align exactly.
  const span = vertical ? a.cropRect.height : a.cropRect.width;
  const cellCount = Math.ceil(span / gridSize);
  for (let k = 0; k < cellCount; k++) {
    const along = k * gridSize;
    const length = Math.min(gridSize, span - along);
    linkCrossingCell(a, b, side, k, along, length, gridSize, level);
    linkCrossingCell(b, a, OPPOSITE_SIDE[side], k, along, length, gridSize, level);
  }
}

/**
 * Create one one-way crossing cell from part `from` to part `to`: a departure teleport square at
 * `from`'s physical scene edge (the outer rim of the overlap buffer) paired with a passive
 * arrival square at the identical map position inside `to`. Because the buffer duplicates the
 * neighbor's content, source and destination squares cover the same map area, so the token does
 * not visually move when the scene switches. The arrival square carries no behavior — otherwise
 * tokens walking through `to`'s interior would be yanked back across the border.
 * @param {ScenePart} from       The departure part.
 * @param {ScenePart} to         The arrival part.
 * @param {"north"|"south"|"east"|"west"} side  Which border of `from` faces `to`.
 * @param {number} k             Zero-based cell index along the border.
 * @param {number} along         Offset of the cell along the physical border, in pixels.
 * @param {number} length        Cell length along the border (shorter for a trailing partial cell).
 * @param {number} gridSize      Grid size in pixels.
 * @param {object} level         The single source level data.
 */
function linkCrossingCell(from, to, side, k, along, length, gridSize, level) {
  const dep = departureCell(from, side, along, length, gridSize);
  // Same map position in the arrival part: undo `from`'s translation, apply `to`'s.
  const arr = {
    x: dep.x - from.delta.dx + to.delta.dx,
    y: dep.y - from.delta.dy + to.delta.dy,
    width: dep.width,
    height: dep.height
  };
  const depId = foundry.utils.randomID();
  const arrId = foundry.utils.randomID();
  from.data.regions.push(buildTeleportRegion({
    id: depId, strip: dep, level, side, index: k + 1,
    targetSceneId: to.data._id, targetSceneName: to.data.name, targetRegionId: arrId
  }));
  to.data.regions.push(buildTeleportRegion({
    entry: true, id: arrId, strip: arr, level, side: OPPOSITE_SIDE[side], index: k + 1,
    targetSceneId: from.data._id, targetSceneName: from.data.name, targetRegionId: depId
  }));
}

/**
 * Compute one departure square at a part's physical scene edge, in local canvas coordinates.
 * The square hugs the outer rim of the overlap buffer so tokens traverse the whole buffer before
 * the scene switches; its offset along the border is measured from the physical scene rectangle
 * origin, which covers the same map interval on both adjacent parts.
 * @param {ScenePart} part       The departure part.
 * @param {"north"|"south"|"east"|"west"} side  The border side holding the square.
 * @param {number} along         Offset of the cell along the physical border, in pixels.
 * @param {number} length        Cell length along the border.
 * @param {number} gridSize      Grid size in pixels; squares are one grid unit deep, clamped for
 *                               scenes thinner than one grid unit.
 * @returns {{x: number, y: number, width: number, height: number}}  The square rectangle.
 */
function departureCell(part, side, along, length, gridSize) {
  const {sceneX, sceneY, sceneWidth, sceneHeight} = part.dims;
  const depth = Math.min(gridSize, (side === "east") || (side === "west") ? sceneWidth : sceneHeight);
  switch (side) {
    case "east": return {x: sceneX + sceneWidth - depth, y: sceneY + along, width: depth, height: length};
    case "west": return {x: sceneX, y: sceneY + along, width: depth, height: length};
    case "south": return {x: sceneX + along, y: sceneY + sceneHeight - depth, width: length, height: depth};
    default: return {x: sceneX + along, y: sceneY, width: length, height: depth};
  }
}

/**
 * Build the creation data of a single teleport border region, modeled after the working
 * reference scenes in demo-data/. Used both at split time and by the border tools when the GM
 * re-creates a deleted crossing.
 * Crossings are one-way pairs: the departure square carries the teleport behavior, while the
 * arrival square (`entry: true`) is a passive destination anchor with no behavior, so tokens
 * walking over it inside the destination scene are not teleported back.
 * The module flags record which border the region guards (`side`), the linked scene (`target`),
 * the paired region id (`mirror`) and whether the square is an arrival (`entry`), so the border
 * tools can find and keep the pair consistent later.
 * @param {object} config                      Region configuration.
 * @param {string} config.id                   Pre-generated region id (required for cross-scene
 *                                             destinations).
 * @param {{x: number, y: number, width: number, height: number}} config.strip  The strip
 *                               rectangle in the local coordinates of the owning scene.
 * @param {object} config.level                The owning scene's single level data.
 * @param {"north"|"south"|"east"|"west"} config.side  Which border of the owning scene the strip
 *                               belongs to.
 * @param {string} config.targetSceneId        Id of the linked scene (destination for departures,
 *                                             origin for arrivals).
 * @param {string} config.targetSceneName      Name of the linked scene (for the region name).
 * @param {string} config.targetRegionId       Pre-generated id of the paired region in the linked
 *                                             scene.
 * @param {number} [config.index]              1-based cell index along the border, appended to the
 *                                             region name so the GM can tell the squares apart.
 * @param {boolean} [config.entry=false]       Build a passive arrival square instead of a
 *                                             departure teleport square.
 * @returns {object}             Region creation data.
 */
export function buildTeleportRegion({id, strip, level, side, targetSceneId, targetSceneName, targetRegionId, index, entry = false}) {
  const nameKey = entry ? "MAPSPLITTER.Region.ArrivalFrom" : "MAPSPLITTER.Region.TeleportTo";
  const baseName = game.i18n.format(nameKey, {name: targetSceneName});
  const behaviors = entry ? [] : [{
    _id: foundry.utils.randomID(),
    name: "Teleport Token",
    type: "teleportToken",
    system: {
      destinations: [`Scene.${targetSceneId}.Region.${targetRegionId}`],
      placement: "relative",
      snap: true,
      choice: false,
      revealed: true,
      dialog: {revealed: null, unrevealed: null},
      transition: {type: null, duration: 1500}
    },
    disabled: false,
    flags: {}
  }];
  return {
    _id: id,
    name: index ? `${baseName} ${index}` : baseName,
    color: TELEPORT_REGION_COLOR,
    elevation: {
      bottom: level.elevation?.bottom ?? 0,
      top: level.elevation?.top ?? null,
      topInclusive: false
    },
    levels: [level._id],
    // Arrival anchors are functional only; showing them mid-scene confuses players and GM alike,
    // so they stay visible solely on the Regions layer (0 = LAYER). Departures remain always
    // visible (2 = ALWAYS) so everyone can see where crossings are open.
    visibility: entry ? 0 : 2,
    highlightMode: "coverage",
    displayMeasurements: false,
    hidden: false,
    shapes: [{
      type: "rectangle",
      x: strip.x,
      y: strip.y,
      width: strip.width,
      height: strip.height,
      hole: false,
      anchorX: 0,
      anchorY: 0,
      rotation: 0,
      gridBased: false
    }],
    behaviors,
    locked: false,
    flags: {[MODULE_ID]: {teleport: true, entry, side, target: targetSceneId, mirror: targetRegionId}}
  };
}
