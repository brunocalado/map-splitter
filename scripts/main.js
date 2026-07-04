/*!
 * Map Splitter
 * Copyright (c) 2026 https://github.com/brunocalado
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License version 3.
 */

/**
 * Map Splitter entry point.
 * Exposes the public `MapSplitter.Open()` API and adds a launcher button to the Scenes sidebar.
 */

import { registerBorderTools } from "./border-tools.js";
import { MODULE_ID } from "./constants.js";
import { SplitEditor } from "./split-editor.js";

Hooks.once("init", () => {
  const api = Object.freeze({
    /**
     * Open the split editor on the active scene.
     * @returns {SplitEditor|null}  The active editor session, or null when validation failed.
     */
    Open: () => SplitEditor.open()
  });
  globalThis.MapSplitter = api;
  const module = game.modules.get(MODULE_ID);
  if (module) module.api = api;
  registerBorderTools();
});

Hooks.on("renderSceneDirectory", (app, element) => {
  if (!game.user.isGM) return;
  const html = element instanceof HTMLElement ? element : element[0];
  const header = html.querySelector(".directory-header .header-actions") ?? html.querySelector(".directory-header");
  if (!header || header.querySelector(`[data-action="${MODULE_ID}-open"]`)) return;
  const button = document.createElement("button");
  button.type = "button";
  button.dataset.action = `${MODULE_ID}-open`;
  button.innerHTML = `<i class="fa-solid fa-scissors"></i> ${game.i18n.localize("MAPSPLITTER.Hud.Title")}`;
  button.addEventListener("click", () => SplitEditor.open());
  header.append(button);
});
