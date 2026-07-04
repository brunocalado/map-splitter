/*!
 * Map Splitter
 * Copyright (c) 2026 https://github.com/brunocalado
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License version 3.
 */

/**
 * Interactive split-line editor.
 * Renders draggable vertical/horizontal cut lines as a PIXI overlay on the canvas interface
 * group, so the user can freely switch scene layers (walls, lights, sounds, ...) while placing
 * cuts. Lines always snap to the scene grid, both visually and authoritatively: the snapped
 * coordinate is the one used for every data operation.
 */

import { CUT_LINE_COLOR, MAX_PARTS } from "./constants.js";
import { runSplit } from "./split-engine.js";
import { SplitHud } from "./split-hud.js";

/**
 * @typedef {object} SplitLine
 * @property {string} id         Unique line id.
 * @property {"v"|"h"} axis      Line orientation: "v" cuts along x, "h" cuts along y.
 * @property {number} coord      Snapped canvas coordinate of the cut.
 * @property {PIXI.Graphics} gfx The canvas representation.
 */

/**
 * Singleton controller for the on-canvas split-line editing session.
 */
export class SplitEditor {
  /** @type {SplitEditor|null} */
  static #instance = null;

  /** @type {foundry.documents.Scene} */
  #scene;

  /** @type {Map<string, SplitLine>} */
  #lines = new Map();

  /** @type {PIXI.Container|null} */
  #container = null;

  /** @type {SplitHud|null} */
  #hud = null;

  /** @type {SplitLine|null} */
  #dragging = null;

  /** @type {number|null} */
  #panHookId = null;

  /** @type {number|null} */
  #tearDownHookId = null;

  /**
   * @param {foundry.documents.Scene} scene  The scene being edited.
   */
  constructor(scene) {
    this.#scene = scene;
  }

  /**
   * The currently active editor session, if any.
   * @returns {SplitEditor|null}
   */
  static get instance() {
    return SplitEditor.#instance;
  }

  /**
   * Open the split editor for the active scene. Entry point exposed as `MapSplitter.Open()`.
   * Validates every scope constraint (GM user, active scene, square grid, exactly one level,
   * background image) before starting a session.
   * @returns {SplitEditor|null}   The active editor, or null when a validation failed.
   */
  static open() {
    if (!game.user.isGM) {
      ui.notifications.warn("MAPSPLITTER.Warn.GmOnly", {localize: true});
      return null;
    }
    if (!canvas?.ready || !canvas.scene) {
      ui.notifications.warn("MAPSPLITTER.Warn.NoScene", {localize: true});
      return null;
    }
    if (SplitEditor.#instance) {
      SplitEditor.#instance.#hud?.render(true);
      return SplitEditor.#instance;
    }
    const scene = canvas.scene;
    if (scene.grid.type !== CONST.GRID_TYPES.SQUARE) {
      ui.notifications.warn("MAPSPLITTER.Warn.SquareOnly", {localize: true});
      return null;
    }
    const levels = scene.toObject().levels ?? [];
    if (levels.length !== 1) {
      ui.notifications.warn("MAPSPLITTER.Warn.SingleLevel", {localize: true});
      return null;
    }
    if (!levels[0]?.background?.src) {
      ui.notifications.warn("MAPSPLITTER.Warn.NoBackground", {localize: true});
      return null;
    }
    const editor = new SplitEditor(scene);
    SplitEditor.#instance = editor;
    editor.#initialize();
    return editor;
  }

  /* -------------------------------------------- */
  /*  Session lifecycle                           */
  /* -------------------------------------------- */

  /**
   * Create the PIXI overlay, register canvas hooks, and open the floating HUD.
   */
  #initialize() {
    this.#container = new PIXI.Container();
    this.#container.zIndex = 1000;
    this.#container.eventMode = "static";
    canvas.interface.addChild(this.#container);
    // Cut lines keep a constant on-screen thickness, so redraw whenever the zoom changes.
    this.#panHookId = Hooks.on("canvasPan", () => this.#redrawAll());
    // Switching or reloading the scene invalidates the session entirely.
    this.#tearDownHookId = Hooks.on("canvasTearDown", () => this.cancel());
    this.#hud = new SplitHud({editor: this});
    this.#hud.render(true);
  }

  /**
   * Abort the editing session, removing the overlay and the HUD. Safe to call repeatedly.
   */
  cancel() {
    if (SplitEditor.#instance !== this) return;
    this.#teardown();
  }

  /**
   * Release every canvas and UI resource owned by this session.
   */
  #teardown() {
    SplitEditor.#instance = null;
    this.#endDrag();
    if (this.#panHookId !== null) Hooks.off("canvasPan", this.#panHookId);
    if (this.#tearDownHookId !== null) Hooks.off("canvasTearDown", this.#tearDownHookId);
    this.#panHookId = this.#tearDownHookId = null;
    if (this.#container && !this.#container.destroyed) this.#container.destroy({children: true});
    this.#container = null;
    this.#lines.clear();
    const hud = this.#hud;
    this.#hud = null;
    hud?.close({mapSplitterTeardown: true});
  }

  /* -------------------------------------------- */
  /*  Line state                                  */
  /* -------------------------------------------- */

  /** @returns {number} The number of vertical cut lines. */
  get verticalCount() {
    return [...this.#lines.values()].filter(line => line.axis === "v").length;
  }

  /** @returns {number} The number of horizontal cut lines. */
  get horizontalCount() {
    return [...this.#lines.values()].filter(line => line.axis === "h").length;
  }

  /** @returns {number} The number of parts the current layout produces. */
  get partCount() {
    return (this.verticalCount + 1) * (this.horizontalCount + 1);
  }

  /**
   * Whether one more line may be added on the given axis without exceeding the part limit.
   * Existing lines may always be moved or removed; only additions are blocked at the limit.
   * @param {"v"|"h"} axis         The candidate axis.
   * @returns {boolean}
   */
  canAddLine(axis) {
    const v = this.verticalCount + (axis === "v" ? 1 : 0);
    const h = this.horizontalCount + (axis === "h" ? 1 : 0);
    return (v + 1) * (h + 1) <= MAX_PARTS;
  }

  /**
   * Summaries of the current lines for display in the HUD, verticals first, each sorted by
   * position.
   * @returns {{id: string, label: string}[]}
   */
  get lineSummaries() {
    return [...this.#lines.values()]
      .sort((a, b) => (a.axis === b.axis) ? a.coord - b.coord : (a.axis === "v" ? -1 : 1))
      .map(line => {
        const {origin, gridSize} = this.#axisInfo(line.axis);
        const index = Math.round((line.coord - origin) / gridSize);
        const key = line.axis === "v" ? "MAPSPLITTER.Hud.VerticalLine" : "MAPSPLITTER.Hud.HorizontalLine";
        return {id: line.id, label: game.i18n.format(key, {index})};
      });
  }

  /**
   * The snapped cut coordinates on one axis, ascending.
   * @param {"v"|"h"} axis         The axis to collect.
   * @returns {number[]}
   */
  cutCoordinates(axis) {
    return [...this.#lines.values()]
      .filter(line => line.axis === axis)
      .map(line => line.coord)
      .sort((a, b) => a - b);
  }

  /**
   * Describe one axis of the scene rectangle for snapping purposes.
   * @param {"v"|"h"} axis         The axis.
   * @returns {{origin: number, extent: number, gridSize: number, maxIndex: number}} Axis metrics;
   *   maxIndex is the highest interior grid-line index a cut may occupy.
   */
  #axisInfo(axis) {
    const dims = canvas.dimensions;
    const origin = axis === "v" ? dims.sceneX : dims.sceneY;
    const extent = axis === "v" ? dims.sceneWidth : dims.sceneHeight;
    const gridSize = dims.size;
    return {origin, extent, gridSize, maxIndex: Math.ceil(extent / gridSize) - 1};
  }

  /**
   * Add a new snapped cut line, choosing the free grid line closest to the current view center.
   * @param {"v"|"h"} axis         The axis of the new line.
   * @returns {SplitLine|null}     The created line, or null when blocked.
   */
  addLine(axis) {
    if (!this.canAddLine(axis)) {
      ui.notifications.warn(game.i18n.format("MAPSPLITTER.Hud.LimitReached", {max: MAX_PARTS}));
      return null;
    }
    const {origin, gridSize, maxIndex} = this.#axisInfo(axis);
    if (maxIndex < 1) {
      ui.notifications.warn("MAPSPLITTER.Warn.AxisTooSmall", {localize: true});
      return null;
    }
    const center = axis === "v" ? canvas.stage.pivot.x : canvas.stage.pivot.y;
    const startIndex = Math.clamp(Math.round((center - origin) / gridSize), 1, maxIndex);
    const occupied = new Set(this.cutCoordinates(axis));
    let coord = null;
    for (let step = 0; step <= maxIndex && coord === null; step++) {
      for (const k of [startIndex + step, startIndex - step]) {
        if (k < 1 || k > maxIndex) continue;
        const candidate = origin + (k * gridSize);
        if (!occupied.has(candidate)) {
          coord = candidate;
          break;
        }
      }
    }
    if (coord === null) {
      ui.notifications.warn("MAPSPLITTER.Warn.NoFreePosition", {localize: true});
      return null;
    }
    return this.#createLine(axis, coord);
  }

  /**
   * Remove a cut line by id.
   * @param {string} id            The line id.
   */
  removeLine(id) {
    const line = this.#lines.get(id);
    if (!line) return;
    if (this.#dragging?.id === id) this.#endDrag();
    if (!line.gfx.destroyed) line.gfx.destroy();
    this.#lines.delete(id);
    this.#hud?.render();
  }

  /**
   * Automatically distribute cut lines on the given axis to be equidistant.
   * If there is only one line, it centers it.
   * @param {"v"|"h"} axis         The axis.
   */
  autoDistribute(axis) {
    const axisLines = [...this.#lines.values()]
      .filter(line => line.axis === axis)
      .sort((a, b) => a.coord - b.coord);
    const n = axisLines.length;
    if (n === 0) return;
    const {origin, gridSize, maxIndex} = this.#axisInfo(axis);
    
    for (let i = 0; i < n; i++) {
      let k = Math.round((i + 1) * (maxIndex + 1) / (n + 1));
      if (i > 0) {
        const prevK = Math.round((axisLines[i - 1].coord - origin) / gridSize);
        if (k <= prevK) k = prevK + 1;
      }
      k = Math.clamp(k, 1, maxIndex - (n - 1 - i));
      
      const snapped = origin + (k * gridSize);
      const line = axisLines[i];
      line.coord = snapped;
      this.#drawLine(line);
    }
    this.#hud?.render();
  }

  /* -------------------------------------------- */
  /*  Canvas rendering & interaction              */
  /* -------------------------------------------- */

  /**
   * Instantiate the PIXI representation of a new line and wire its pointer events.
   * @param {"v"|"h"} axis         The line axis.
   * @param {number} coord         The snapped canvas coordinate.
   * @returns {SplitLine}
   */
  #createLine(axis, coord) {
    const id = foundry.utils.randomID(8);
    const gfx = new PIXI.Graphics();
    gfx.eventMode = "static";
    gfx.cursor = axis === "v" ? "ew-resize" : "ns-resize";
    const line = {id, axis, coord, gfx};
    gfx.on("pointerdown", event => this.#onLineDown(event, line));
    gfx.on("rightdown", event => {
      event.stopPropagation();
      this.removeLine(id);
    });
    this.#container.addChild(gfx);
    this.#lines.set(id, line);
    this.#drawLine(line);
    this.#hud?.render();
    return line;
  }

  /**
   * Draw one line across the scene rectangle with a constant ~2px on-screen thickness and a
   * generous invisible hit area for dragging.
   * @param {SplitLine} line       The line to draw.
   */
  #drawLine(line) {
    const rect = canvas.dimensions.sceneRect;
    const scale = canvas.stage.scale.x || 1;
    const thickness = 2 / scale;
    const grab = 16 / scale;
    const gfx = line.gfx;
    gfx.clear();
    gfx.lineStyle({width: thickness, color: CUT_LINE_COLOR, alpha: 0.95});
    if (line.axis === "v") {
      gfx.moveTo(line.coord, rect.y);
      gfx.lineTo(line.coord, rect.y + rect.height);
      gfx.hitArea = new PIXI.Rectangle(line.coord - (grab / 2), rect.y, grab, rect.height);
    } else {
      gfx.moveTo(rect.x, line.coord);
      gfx.lineTo(rect.x + rect.width, line.coord);
      gfx.hitArea = new PIXI.Rectangle(rect.x, line.coord - (grab / 2), rect.width, grab);
    }
  }

  /**
   * Redraw every line. Called from the `canvasPan` hook so thickness tracks the zoom level.
   */
  #redrawAll() {
    if (!this.#container || this.#container.destroyed) return;
    for (const line of this.#lines.values()) this.#drawLine(line);
  }

  /**
   * Begin dragging a line. Stops propagation so the canvas does not pan or box-select.
   * @param {PIXI.FederatedPointerEvent} event  The pointerdown event.
   * @param {SplitLine} line       The grabbed line.
   */
  #onLineDown(event, line) {
    if (event.button !== 0) return;
    event.stopPropagation();
    this.#dragging = line;
    canvas.stage.on("pointermove", this.#onDragMove);
    canvas.stage.on("pointerup", this.#onDragEnd);
    canvas.stage.on("pointerupoutside", this.#onDragEnd);
  }

  /**
   * Drag handler: snap the pointer position to the grid and move the line. The line never leaves
   * the grid and never stacks on another line of the same axis.
   * @param {PIXI.FederatedPointerEvent} event  The pointermove event.
   */
  #onDragMove = event => {
    const line = this.#dragging;
    if (!line) return;
    const position = event.getLocalPosition(this.#container);
    const value = line.axis === "v" ? position.x : position.y;
    const {origin, gridSize, maxIndex} = this.#axisInfo(line.axis);
    const k = Math.clamp(Math.round((value - origin) / gridSize), 1, maxIndex);
    const snapped = origin + (k * gridSize);
    if (snapped === line.coord) return;
    const occupied = this.cutCoordinates(line.axis).some(c => c === snapped);
    if (occupied) return;
    line.coord = snapped;
    this.#drawLine(line);
    this.#hud?.render();
  };

  /**
   * End the active drag interaction.
   */
  #onDragEnd = () => this.#endDrag();

  /**
   * Detach the temporary stage listeners installed for dragging.
   */
  #endDrag() {
    this.#dragging = null;
    if (!canvas?.stage) return;
    canvas.stage.off("pointermove", this.#onDragMove);
    canvas.stage.off("pointerup", this.#onDragEnd);
    canvas.stage.off("pointerupoutside", this.#onDragEnd);
  }

  /* -------------------------------------------- */
  /*  Apply                                       */
  /* -------------------------------------------- */

  /**
   * Confirm and execute the split, tearing the editing session down first.
   * @returns {Promise<void>}
   */
  async apply() {
    if (this.partCount < 2) {
      ui.notifications.warn("MAPSPLITTER.Warn.NeedLine", {localize: true});
      return;
    }
    const count = this.partCount;
    const content = `<p>${game.i18n.format("MAPSPLITTER.Confirm.Content", {name: this.#scene.name, count})}</p>`;
    const confirmed = await foundry.applications.api.DialogV2.confirm({
      window: {title: "MAPSPLITTER.Confirm.Title", icon: "fa-solid fa-scissors"},
      content
    });
    if (!confirmed) return;
    const scene = this.#scene;
    const vCuts = this.cutCoordinates("v");
    const hCuts = this.cutCoordinates("h");
    this.#teardown();
    await runSplit(scene, vCuts, hCuts);
  }
}
