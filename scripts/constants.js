/*!
 * Map Splitter
 * Copyright (c) 2026 https://github.com/brunocalado
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License version 3.
 */

/**
 * Module-wide shared constants for Map Splitter.
 * This file is a dependency-free leaf: it must never import anything from the rest of the module,
 * so it can be imported anywhere without circular-import risk.
 */

/** @type {string} The module id. Single source of truth mirroring the `id` field in module.json. */
export const MODULE_ID = "map-splitter";

/** @type {number} Hard limit on the number of parts a single split operation may produce. */
export const MAX_PARTS = 15;

/** @type {string} Server-side folder (relative to the "data" storage root) where sliced images are stored. */
export const UPLOAD_DIR = "map-splitter";

/** @type {string} FilePicker storage source used for uploads and browsing. */
export const UPLOAD_SOURCE = "data";

/** @type {number} Encoder quality used when converting sliced background images to WebP. */
export const WEBP_QUALITY = 0.92;

/** @type {number} Canvas color of the split cut lines (bright magenta so it stays visible on any map). */
export const CUT_LINE_COLOR = 0xFF2BD6;

/** @type {string} Region color applied to the generated teleport border regions. */
export const TELEPORT_REGION_COLOR = "#aacc28";

/**
 * @type {number} Overlap buffer depth, in grid squares, added to every part edge that faces an
 * adjacent part. The buffer duplicates the neighboring content (image, walls, ...) so scene
 * transitions do not show an abrupt cut at the border.
 */
export const OVERLAP_SQUARES = 4;

/** @type {string} Scene flag key holding the map of adjacent generated scene ids, keyed by side. */
export const FLAG_NEIGHBORS = "neighbors";

/**
 * @type {string} Scene flag key holding the pixel insets ({left, top, right, bottom}) of the
 * logical content rectangle within the generated scene rectangle — i.e. how deep the overlap
 * buffer is on each side. Absent (all zero) on scenes generated before overlap support.
 */
export const FLAG_INSETS = "insets";

/** @type {Record<string, string>} Opposite border side lookup, shared by scene generation and the border tools. */
export const OPPOSITE_SIDE = {north: "south", south: "north", east: "west", west: "east"};

/** @type {Record<string, string>} Handlebars template paths used by the module's Applications. */
export const TEMPLATES = {
  HUD: `modules/${MODULE_ID}/templates/split-hud.hbs`,
  PROGRESS: `modules/${MODULE_ID}/templates/progress.hbs`
};
