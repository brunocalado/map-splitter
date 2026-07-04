/*!
 * Map Splitter
 * Copyright (c) 2026 https://github.com/brunocalado
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License version 3.
 */

/**
 * Background-image slicing and server upload utilities.
 * Slices are encoded as WebP and stored in the server-side "map-splitter" folder with
 * deterministic, collision-safe filenames.
 */

import { UPLOAD_DIR, UPLOAD_SOURCE, WEBP_QUALITY } from "./constants.js";

/**
 * Resolve the active FilePicker implementation so host environments can substitute their own.
 * @returns {typeof foundry.applications.apps.FilePicker} The FilePicker class to use.
 */
function filePickerClass() {
  const FilePickerBase = foundry.applications.apps.FilePicker;
  return FilePickerBase.implementation ?? FilePickerBase;
}

/**
 * Convert a scene name into a kebab-case file slug without spaces, accents, or special characters.
 * @param {string} name          The scene name (e.g. "Cidade Grande").
 * @returns {string}             The slug (e.g. "cidade-grande"); never empty.
 */
export function slugifySceneName(name) {
  const slug = String(name)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "scene";
}

/**
 * Fetch and decode the source background image.
 * The path is resolved by the browser relative to the current page, so route prefixes and
 * absolute URLs both work.
 * @param {string} src           The background image path as stored on the scene.
 * @returns {Promise<ImageBitmap>} The decoded image.
 */
export async function loadImageBitmap(src) {
  let response;
  try {
    response = await fetch(src);
  } catch (err) {
    throw new Error(`Could not fetch the background image "${src}": ${err.message}`);
  }
  if (!response.ok) throw new Error(`Could not fetch the background image "${src}" (HTTP ${response.status}).`);
  const blob = await response.blob();
  return createImageBitmap(blob);
}

/**
 * Crop one part out of the source image and encode it as WebP at native resolution.
 * @param {ImageBitmap} bitmap   The decoded source image.
 * @param {{x: number, y: number, width: number, height: number}} crop  Crop rectangle in source
 *                               image pixel coordinates.
 * @returns {Promise<Blob>}      The encoded WebP blob.
 */
export async function slicePartImage(bitmap, crop) {
  const sx = Math.clamp(Math.round(crop.x), 0, bitmap.width - 1);
  const sy = Math.clamp(Math.round(crop.y), 0, bitmap.height - 1);
  const sw = Math.clamp(Math.round(crop.width), 1, bitmap.width - sx);
  const sh = Math.clamp(Math.round(crop.height), 1, bitmap.height - sy);
  let blob;
  if (typeof OffscreenCanvas !== "undefined") {
    const surface = new OffscreenCanvas(sw, sh);
    surface.getContext("2d").drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh);
    blob = await surface.convertToBlob({type: "image/webp", quality: WEBP_QUALITY});
  } else {
    const surface = document.createElement("canvas");
    surface.width = sw;
    surface.height = sh;
    surface.getContext("2d").drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh);
    blob = await new Promise((resolve, reject) => surface.toBlob(
      b => b ? resolve(b) : reject(new Error("Image encoding produced no data.")),
      "image/webp", WEBP_QUALITY
    ));
  }
  // Browsers without WebP encoding silently fall back to PNG; that would violate the
  // required output format, so fail loudly instead.
  if (blob.type !== "image/webp") {
    throw new Error("This browser cannot encode WebP images. Use the Foundry desktop client or a Chromium-based browser.");
  }
  return blob;
}

/**
 * Ensure the server-side upload folder exists, tolerating the folder already being present.
 * @returns {Promise<void>}
 */
export async function ensureUploadDirectory() {
  const FilePickerClass = filePickerClass();
  try {
    await FilePickerClass.createDirectory(UPLOAD_SOURCE, UPLOAD_DIR);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!/EEXIST|already exists/i.test(message)) throw err;
  }
}

/**
 * List the filenames already present in the upload folder (lowercased basenames).
 * @returns {Promise<Set<string>>} The set of existing filenames.
 */
export async function listExistingFiles() {
  const FilePickerClass = filePickerClass();
  const result = await FilePickerClass.browse(UPLOAD_SOURCE, UPLOAD_DIR);
  const names = new Set();
  for (const path of result?.files ?? []) {
    const name = decodeURIComponent(path.split("/").pop() ?? "");
    if (name) names.add(name.toLowerCase());
  }
  return names;
}

/**
 * Produce a deterministic collision-safe filename and reserve it in the existing-names set.
 * Follows the documented collision rule: "cidade-grande-1-1.webp" → "cidade-grande-1-1_1.webp".
 * @param {string} base          Filename base without extension (e.g. "cidade-grande-1-1").
 * @param {Set<string>} existing Lowercased names already taken; the chosen name is added to it.
 * @returns {string}             The collision-free filename including the .webp extension.
 */
export function collisionFreeName(base, existing) {
  let name = `${base}.webp`;
  for (let n = 1; existing.has(name.toLowerCase()); n++) name = `${base}_${n}.webp`;
  existing.add(name.toLowerCase());
  return name;
}

/**
 * Upload one encoded image blob to the module's server folder.
 * @param {Blob} blob            The encoded WebP blob.
 * @param {string} filename      The collision-free target filename.
 * @returns {Promise<string>}    The server path of the stored file, as returned by the upload.
 */
export async function uploadImage(blob, filename) {
  const FilePickerClass = filePickerClass();
  const file = new File([blob], filename, {type: "image/webp"});
  const result = await FilePickerClass.upload(UPLOAD_SOURCE, UPLOAD_DIR, file, {}, {notify: false});
  if (!result?.path) throw new Error(`Upload failed for "${filename}".`);
  return result.path;
}
