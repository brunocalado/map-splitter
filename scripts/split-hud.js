/*!
 * Map Splitter
 * Copyright (c) 2026 https://github.com/brunocalado
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License version 3.
 */

/**
 * Floating HUD companion of the split editor: shows the live part count, add/remove controls,
 * and the Apply/Cancel actions.
 */

import { MAX_PARTS, TEMPLATES } from "./constants.js";

const {ApplicationV2, HandlebarsApplicationMixin} = foundry.applications.api;

/**
 * The floating control window of an active split-editing session.
 * @extends {foundry.applications.api.ApplicationV2}
 */
export class SplitHud extends HandlebarsApplicationMixin(ApplicationV2) {
  /** @override */
  static DEFAULT_OPTIONS = {
    id: "map-splitter-hud",
    classes: ["map-splitter", "map-splitter-hud"],
    window: {
      title: "MAPSPLITTER.Hud.Title",
      icon: "fa-solid fa-scissors",
      minimizable: false,
      resizable: false
    },
    position: {width: 320, height: "auto"},
    actions: {
      addVertical: this.prototype._onAddVertical,
      addHorizontal: this.prototype._onAddHorizontal,
      autoVertical: this.prototype._onAutoVertical,
      autoHorizontal: this.prototype._onAutoHorizontal,
      removeLine: this.prototype._onRemoveLine,
      applySplit: this.prototype._onApplySplit,
      cancelSplit: this.prototype._onCancelSplit
    }
  };

  /** @override */
  static PARTS = {
    main: {template: TEMPLATES.HUD}
  };

  /** @type {import("./split-editor.js").SplitEditor} */
  #editor;

  /**
   * @param {object} options       Application options.
   * @param {import("./split-editor.js").SplitEditor} options.editor  The owning editor session.
   */
  constructor(options = {}) {
    const {editor, ...rest} = options;
    super(rest);
    this.#editor = editor;
  }

  /**
   * Build the render context with the live layout preview. Called for the full render.
   * @param {object} options       Render options.
   * @returns {Promise<object>}    The template context.
   * @override
   */
  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const editor = this.#editor;
    return Object.assign(context, {
      parts: editor.partCount,
      maxParts: MAX_PARTS,
      rows: editor.horizontalCount + 1,
      cols: editor.verticalCount + 1,
      canAddVertical: editor.canAddLine("v"),
      canAddHorizontal: editor.canAddLine("h"),
      hasVertical: editor.verticalCount > 0,
      hasHorizontal: editor.horizontalCount > 0,
      atLimit: !editor.canAddLine("v") && !editor.canAddLine("h"),
      canApply: editor.partCount >= 2,
      lines: editor.lineSummaries
    });
  }

  /**
   * Closing the HUD through its window controls aborts the whole editing session; when the
   * editor itself tears down it passes a flag to avoid recursion.
   * @param {object} options       Close options.
   * @override
   */
  _onClose(options) {
    super._onClose(options);
    if (!options?.mapSplitterTeardown) this.#editor?.cancel();
  }

  /**
   * Add a vertical cut line. Declared in DEFAULT_OPTIONS.actions.
   * @param {PointerEvent} event   The originating click event.
   * @param {HTMLElement} target   The action button.
   */
  _onAddVertical(event, target) {
    this.#editor.addLine("v");
  }

  /**
   * Add a horizontal cut line. Declared in DEFAULT_OPTIONS.actions.
   * @param {PointerEvent} event   The originating click event.
   * @param {HTMLElement} target   The action button.
   */
  _onAddHorizontal(event, target) {
    this.#editor.addLine("h");
  }

  /**
   * Automatically distribute vertical cut lines.
   * @param {PointerEvent} event
   * @param {HTMLElement} target
   */
  _onAutoVertical(event, target) {
    this.#editor.autoDistribute("v");
  }

  /**
   * Automatically distribute horizontal cut lines.
   * @param {PointerEvent} event
   * @param {HTMLElement} target
   */
  _onAutoHorizontal(event, target) {
    this.#editor.autoDistribute("h");
  }

  /**
   * Remove the line referenced by the clicked list entry. Declared in DEFAULT_OPTIONS.actions.
   * @param {PointerEvent} event   The originating click event.
   * @param {HTMLElement} target   The action button carrying data-line-id.
   */
  _onRemoveLine(event, target) {
    const id = target.dataset.lineId;
    if (id) this.#editor.removeLine(id);
  }

  /**
   * Apply the split. Declared in DEFAULT_OPTIONS.actions.
   * @param {PointerEvent} event   The originating click event.
   * @param {HTMLElement} target   The action button.
   * @returns {Promise<void>}
   */
  async _onApplySplit(event, target) {
    await this.#editor.apply();
  }

  /**
   * Abort the editing session. Declared in DEFAULT_OPTIONS.actions.
   * @param {PointerEvent} event   The originating click event.
   * @param {HTMLElement} target   The action button.
   */
  _onCancelSplit(event, target) {
    this.#editor.cancel();
  }
}
