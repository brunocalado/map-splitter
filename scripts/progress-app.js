/*!
 * Map Splitter
 * Copyright (c) 2026 https://github.com/brunocalado
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License version 3.
 */

/**
 * Blocking progress window shown while a split operation runs.
 * The window cannot be closed while locked; it unlocks automatically on success or failure.
 */

import { TEMPLATES } from "./constants.js";

const {ApplicationV2, HandlebarsApplicationMixin} = foundry.applications.api;

/**
 * A locked progress dialog with a phase label and a progress bar.
 * @extends {foundry.applications.api.ApplicationV2}
 */
export class ProgressApp extends HandlebarsApplicationMixin(ApplicationV2) {
  /** @override */
  static DEFAULT_OPTIONS = {
    id: "map-splitter-progress",
    classes: ["map-splitter", "map-splitter-progress"],
    window: {
      title: "MAPSPLITTER.Progress.Title",
      icon: "fa-solid fa-scissors",
      minimizable: false,
      resizable: false
    },
    position: {width: 420, height: "auto"},
    actions: {
      closeProgress: this.prototype._onCloseProgress
    }
  };

  /** @override */
  static PARTS = {
    main: {template: TEMPLATES.PROGRESS}
  };

  /** @type {boolean} While locked, every close attempt without `force` is rejected. */
  #locked = true;

  /** @type {string} Localized label of the current processing phase. */
  #phase = "";

  /** @type {number} Completed steps within the current phase. */
  #current = 0;

  /** @type {number} Total steps of the current phase; 0 renders an indeterminate bar. */
  #total = 0;

  /** @type {boolean} Whether processing finished successfully. */
  #done = false;

  /** @type {string|null} Failure message, when processing failed. */
  #error = null;

  /** @type {string} Localized success message. */
  #message = "";

  /**
   * Build the render context. Called for the full render.
   * @param {object} options       Render options.
   * @returns {Promise<object>}    The template context.
   * @override
   */
  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    return Object.assign(context, {
      phase: this.#phase,
      current: this.#current,
      total: this.#total,
      percent: this.#total ? Math.round((this.#current / this.#total) * 100) : 0,
      indeterminate: !this.#total && !this.#done && !this.#error,
      done: this.#done,
      error: this.#error,
      message: this.#message,
      showClose: !this.#locked
    });
  }

  /**
   * Reject close attempts while the critical processing phase is running, so the user cannot
   * accidentally dismiss the window. Pass `{force: true}` to bypass the lock.
   * @param {object} [options]     Close options.
   * @returns {Promise<this>}
   * @override
   */
  async close(options = {}) {
    if (this.#locked && options.force !== true) return this;
    return super.close(options);
  }

  /**
   * Enter a new processing phase and re-render.
   * @param {string} phaseKey      Localization key of the phase label.
   * @param {number} [total=0]     Total step count; 0 shows an indeterminate bar.
   */
  setPhase(phaseKey, total = 0) {
    this.#phase = game.i18n.localize(phaseKey);
    this.#total = total;
    this.#current = 0;
    this.render();
  }

  /**
   * Advance the current phase. Patches the DOM directly to avoid re-render flicker on
   * high-frequency updates.
   * @param {number} current       Completed step count within the current phase.
   */
  tick(current) {
    this.#current = current;
    const element = this.element;
    if (!element) return;
    const fill = element.querySelector(".msp-progress-fill");
    if (fill && this.#total) fill.style.width = `${Math.round((current / this.#total) * 100)}%`;
    const count = element.querySelector(".msp-progress-count");
    if (count) count.textContent = this.#total ? `${current} / ${this.#total}` : "";
  }

  /**
   * Mark the operation as successfully completed and unlock the window.
   * @param {string} message       Localized success message.
   */
  finish(message) {
    this.#done = true;
    this.#message = message;
    this.#locked = false;
    this.render();
  }

  /**
   * Mark the operation as failed and unlock the window.
   * @param {string} message       Failure description shown to the user.
   */
  fail(message) {
    this.#error = message || "Unknown error";
    this.#locked = false;
    this.render();
  }

  /**
   * Handle the close button once the window is unlocked. Declared in DEFAULT_OPTIONS.actions.
   * @param {PointerEvent} event   The originating click event.
   * @param {HTMLElement} target   The action button.
   */
  _onCloseProgress(event, target) {
    this.close({force: true});
  }
}
