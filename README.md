# Map Splitter

Slice huge maps into smaller, lighter scenes for Foundry VTT v14. Gigantic scenes eat player RAM and bandwidth — Map Splitter cuts them into up to 15 grid-aligned parts, splits the background image, reassigns the scene data, and links everything back together with teleport regions.

<img src="docs/preview-before-cut.webp">

<img src="docs/preview-after-cut.webp">

[![Buy Me a Coffee](https://img.shields.io/badge/Buy_Me_a_Coffee-Donate-FFDD00?style=for-the-badge&logo=buy-me-a-coffee&logoColor=black)](https://buymeacoffee.com/mestredigital) [![More Modules](https://img.shields.io/badge/Foundry%20VTT-More%20Modules-red?style=for-the-badge&logo=gamepad)](https://mestredigital.online/pages/projetos-en)

# How it Works

1. Open the scene you want to split and run `MapSplitter.Open();` (or use the button in the Scenes sidebar).

<p align="center"><img src="docs/scenes-button.webp"></p>
2. Add vertical and horizontal split lines from the floating HUD. Lines snap to the grid; drag them on the canvas to move, right-click to remove. You can switch scene layers (walls, lights, sounds, …) freely while choosing the best cutting points.
3. Click **Apply Split**. The module slices the background into WebP images (stored in the server folder `map-splitter`), rebuilds the scene data for each part, and creates the new scenes in one batch. The original scene is never modified.

## Features

- Up to **15 parts** per split, with a live part-count preview that blocks additional lines at the limit.
- Background image sliced at native resolution and saved as **WebP** with deterministic, collision-safe filenames (`my-map-1-2.webp`, `my-map-1-2_1.webp`, …).
- Every edge that faces an adjacent part gets a **4-grid-square overlap buffer**: the generated scene also contains a copy of the bordering image and walls of its neighbors, so players never see an abrupt cut when a token approaches or crosses a border.
- Walls are geometrically split at the cut line; **doors are duplicated whole** so they stay interactable.
- Lights and sounds are duplicated into every scene their radius reaches, even across borders.
- Tiles, drawings, notes and regions are reassigned/duplicated with recalculated coordinates.
- Adjacent scenes are linked with **one-square teleport regions at the scene edges** (`relative` placement): every grid cell of a shared border gets a departure square on the outer rim of the overlap buffer and a passive arrival square at the identical map position in the neighbor scene, per direction. Tokens traverse the buffer and switch scenes without visually moving, and each crossing cell can be managed individually.
- **Border crossing tools**: on generated scenes, the Region Controls gain two extra tools — *Add Border Crossing* and *Remove Border Crossing*. Click a border grid square to create or delete the teleport pair there; the mirrored square of the linked neighbor scene is updated automatically, so you can quickly seal off walled rooms or dead ends the automatic generation cannot know about.
- Generated scenes are filed into a **Scene folder** named after the source scene (reused on later re-splits of the same scene).
- Blocking progress window with per-phase progress bars.

**Scope of the initial version:** square grids only, scenes with exactly one level, tokens are ignored, and fog exploration is not preserved (exploration restarts in each generated scene).

## Usage

Open the importer from the Scenes directory sidebar button, or from a macro / the console:

```js
MapSplitter.Open();
```

# 📦 Installation

Install via the Foundry VTT Module browser or use this manifest link:

```javascript
https://raw.githubusercontent.com/brunocalado/map-splitter/main/module.json
```

# ⚖️ Credits & License

* **Code License:** GNU GPLv3.

* **Demo:** The maps are from Dungeon Alchemist and are under their license: https://www.dungeonalchemist.com/terms-of-use
