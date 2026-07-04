/*!
 * Map Splitter
 * Copyright (c) 2026 https://github.com/brunocalado
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License version 3.
 */

/**
 * Split orchestration: slices the background image, uploads the parts, rebuilds the scene data,
 * and creates every generated scene in a single batched database operation, reporting progress
 * through a blocking window.
 */

import { MAX_PARTS, MODULE_ID, OVERLAP_SQUARES } from "./constants.js";
import { buildPartScenes, partCropRect } from "./data-splitter.js";
import {
  collisionFreeName,
  ensureUploadDirectory,
  listExistingFiles,
  loadImageBitmap,
  slicePartImage,
  slugifySceneName,
  uploadImage
} from "./image-slicer.js";
import { ProgressApp } from "./progress-app.js";

/**
 * Execute the full split operation for a scene.
 * The original scene is never modified; all generated scenes are created alongside it.
 * @param {foundry.documents.Scene} scene  The source scene.
 * @param {number[]} vCuts       Vertical cut coordinates in canvas space (snapped by the editor;
 *                               re-snapped here defensively).
 * @param {number[]} hCuts       Horizontal cut coordinates in canvas space.
 * @returns {Promise<foundry.documents.Scene[]|null>}  The created scenes, or null on failure.
 */
export async function runSplit(scene, vCuts, hCuts) {
  const progress = new ProgressApp();
  await progress.render(true);
  try {
    const dims = scene.dimensions;
    const xs = buildEdges(vCuts, dims.sceneX, dims.sceneWidth, dims.size);
    const ys = buildEdges(hCuts, dims.sceneY, dims.sceneHeight, dims.size);
    const rows = ys.length - 1;
    const cols = xs.length - 1;
    const total = rows * cols;
    if (total < 2) throw new Error(game.i18n.localize("MAPSPLITTER.Error.NoCuts"));
    if (total > MAX_PARTS) throw new Error(game.i18n.format("MAPSPLITTER.Error.TooManyParts", {max: MAX_PARTS}));

    progress.setPhase("MAPSPLITTER.Progress.Preparing");
    const src = scene.toObject();
    const level = src.levels?.[0];
    const backgroundSrc = level?.background?.src;
    if (!backgroundSrc) throw new Error(game.i18n.localize("MAPSPLITTER.Warn.NoBackground"));
    warnCustomTextures(level);
    const bitmap = await loadImageBitmap(backgroundSrc);
    // The background maps onto the scene rectangle with the default "fill" fit, so these factors
    // convert canvas units to source-image pixels and keep slices at native resolution.
    const factorX = bitmap.width / dims.sceneWidth;
    const factorY = bitmap.height / dims.sceneHeight;

    await ensureUploadDirectory();
    const existing = await listExistingFiles();
    const slug = slugifySceneName(scene.name);

    progress.setPhase("MAPSPLITTER.Progress.Images", total);
    const overlapPx = OVERLAP_SQUARES * dims.size;
    const imagePaths = [];
    let done = 0;
    for (let i = 0; i < rows; i++) {
      for (let j = 0; j < cols; j++) {
        // The crop includes the overlap buffer, matching the generated scene rectangle exactly.
        const cropRect = partCropRect(i, j, xs, ys, dims, overlapPx);
        const crop = {
          x: (cropRect.x - dims.sceneX) * factorX,
          y: (cropRect.y - dims.sceneY) * factorY,
          width: cropRect.width * factorX,
          height: cropRect.height * factorY
        };
        const blob = await slicePartImage(bitmap, crop);
        const filename = collisionFreeName(`${slug}-${i + 1}-${j + 1}`, existing);
        imagePaths.push(await uploadImage(blob, filename));
        progress.tick(++done);
      }
    }
    bitmap.close();

    progress.setPhase("MAPSPLITTER.Progress.Building");
    const folder = await ensureSceneFolder(scene);
    const scenesData = buildPartScenes(scene, xs, ys, imagePaths, folder?.id ?? null);

    progress.setPhase("MAPSPLITTER.Progress.Creating");
    const SceneClass = CONFIG.Scene.documentClass;
    // Ids were pre-generated so the teleport regions can reference their cross-scene
    // destinations; keepId/keepEmbeddedIds preserve them through the batched creation.
    const created = await SceneClass.createDocuments(scenesData, {keepId: true, keepEmbeddedIds: true});

    progress.setPhase("MAPSPLITTER.Progress.Thumbnails", created.length);
    const thumbUpdates = [];
    for (let k = 0; k < created.length; k++) {
      try {
        const {thumb} = await created[k].createThumbnail();
        if (thumb) thumbUpdates.push({_id: created[k].id, thumb});
      } catch (err) {
        console.warn(`${MODULE_ID} | Thumbnail generation failed for "${created[k].name}"`, err);
      }
      progress.tick(k + 1);
    }
    if (thumbUpdates.length) await SceneClass.updateDocuments(thumbUpdates);

    const message = game.i18n.format("MAPSPLITTER.Progress.Done", {count: created.length});
    progress.finish(message);
    ui.notifications.info(message);
    return created;
  } catch (err) {
    console.error(`${MODULE_ID} |`, err);
    progress.fail(game.i18n.format("MAPSPLITTER.Error.Failed", {message: err.message}));
    return null;
  }
}

/**
 * Find or create the Scene folder that receives the generated scenes.
 * One folder per source scene, identified by a module flag rather than by name so renaming the
 * folder (or the source scene) never spawns duplicates on later re-splits.
 * @param {foundry.documents.Scene} scene  The source scene.
 * @returns {Promise<foundry.documents.Folder|null>}  The folder, or null when creation failed.
 */
async function ensureSceneFolder(scene) {
  const existing = game.folders.find(f =>
    (f.type === "Scene") && (f.getFlag(MODULE_ID, "sourceScene") === scene.id));
  if (existing) return existing;
  try {
    return await Folder.implementation.create({
      name: scene.name,
      type: "Scene",
      flags: {[MODULE_ID]: {sourceScene: scene.id}}
    });
  } catch (err) {
    console.warn(`${MODULE_ID} | Scene folder creation failed`, err);
    return null;
  }
}

/**
 * Normalize cut coordinates into the ascending list of part edges for one axis.
 * Cuts are re-snapped to the grid, deduplicated, and restricted to the scene interior, so the
 * generation logic stays grid-aligned even if a caller bypasses the editor's snapping.
 * @param {number[]} cuts        Raw cut coordinates in canvas space.
 * @param {number} origin        Scene rectangle origin on this axis.
 * @param {number} extent        Scene rectangle extent on this axis.
 * @param {number} gridSize      Grid size in pixels.
 * @returns {number[]}           Edges including both scene bounds (length = parts + 1).
 */
function buildEdges(cuts, origin, extent, gridSize) {
  const snapped = cuts
    .map(c => origin + (Math.round((c - origin) / gridSize) * gridSize))
    .filter(c => c > origin && c < origin + extent);
  const unique = [...new Set(snapped)].sort((a, b) => a - b);
  return [origin, ...unique, origin + extent];
}

/**
 * Warn once when the source level uses custom background texture adjustments, which the slicer
 * cannot reproduce; slicing then assumes the default full-fit placement.
 * @param {object} level         The single source level data.
 */
function warnCustomTextures(level) {
  const tex = level.textures ?? {};
  const custom = tex.offsetX || tex.offsetY || tex.rotation
    || (tex.scaleX ?? 1) !== 1 || (tex.scaleY ?? 1) !== 1
    || (tex.fit && tex.fit !== "fill");
  if (custom) ui.notifications.warn("MAPSPLITTER.Warn.CustomTextures", {localize: true});
}
