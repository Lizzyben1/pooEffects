# Possible Bugs (Sorted by Severity: Most Severe to Least Severe)

This document contains all detected bugs in the **pooEffects** codebase, ordered strictly from **most severe** (system freezes, crashes, deadlocks, and interaction blockers) to **least severe** (minor UI glitches and display oversights). Each entry includes its file location, severity rating, and a one-sentence explanation of what it is.

---

### 1. Renderer / Playback Cache Deadlock Freezes Pipeline (`hasRoom()` vs Eviction)
- **Location:** `src/state/cache.ts` (L123–132, L167–169), `src/state/playback.ts` (L127), `src/state/engine.ts` (L115)
- **Severity:** Critical (System Deadlock / Hang)
- When the RAM cache reaches 98% capacity, rendering and playback halt permanently because the prefetch check stops submitting frames before the cache eviction routine can run, requiring a manual cache purge to resume.

---

### 2. Context Menu Submenu Premature Dismissal on Pointerdown
- **Location:** `src/ui/controls/Popover.tsx` (L32–42), `src/ui/controls/Menu.tsx` (L25–46)
- **Severity:** Critical (Primary Interaction Blocker)
- Clicking any submenu item in the right-click context menu fails because the parent menu portal dismisses itself on pointerdown before the item's click event can fire, preventing all submenu actions from running unless executed via keyboard shortcuts.

---

### 3. Evicted Cache Bitmaps Crash Viewer Paint with `InvalidStateError`
- **Location:** `src/ui/viewer/ViewPane.tsx` (L139–144), `src/state/cache.ts` (L65)
- **Severity:** Critical (Unhandled Exception / Canvas Blackout)
- When the cache evicts an ImageBitmap that the viewer is currently referencing, subsequent canvas repaints throw an unhandled `InvalidStateError` that blanks the viewer permanently.

---

### 4. `HTMLCanvasElement.convertToBlob` Missing in Inline Export Fallback
- **Location:** `src/export/exporter.ts` (L130), `src/render/host.ts` (L93)
- **Severity:** Critical (Export Crash)
- When the render worker falls back to the main thread, PNG sequence export calls `convertToBlob` on an `HTMLCanvasElement`, which throws an unhandled `TypeError` that crashes the export process immediately.

---

### 5. 3D Camera Tracker Singular Degeneracy When Plane Normal Aligns with X-Axis
- **Location:** `src/state/tracking.ts` (L939–943), `src/cv/linalg.ts` (L271)
- **Severity:** Critical (Mathematical Singularity / Corrupted Orientation)
- Defining a 3D ground plane whose surface normal is parallel to the X-axis projects $[1,0,0]$ into a zero vector, causing zero-division, `NaN` rotation matrices, and corrupted camera orientation.

---

### 6. `renderForView` Discards Rendered Frames & Blanks Canvas on Cache Rejection
- **Location:** `src/state/engine.ts` (L70–75), `src/ui/viewer/ViewPane.tsx` (L213–216)
- **Severity:** High (Silent Frame Drop / Visual Freezing)
- If the cache rejects a rendered frame during active scrubbing due to an in-flight signature mismatch, `renderForView` returns null and drops the valid frame instead of presenting it, causing viewer freezes and black frames.

---

### 7. Pen Tool Coordinates Distorted on Viewer Pan or Zoom
- **Location:** `src/ui/viewer/ViewPane.tsx` (L926, L946–952)
- **Severity:** High (Vector Path Corruption)
- Storing pen points in raw screen coordinates instead of composition space causes all previously drawn vertices to warp and distort if the user pans or zooms the viewer before completing the path.

---

### 8. Timeline Audio Playback Gated Exclusively on 100% RAM Cache Completion
- **Location:** `src/state/playback.ts` (L51–77, L98–99, L153–177), `src/audio/engine.ts` (L132–151)
- **Severity:** High (Audio Playback Muting)
- Audio on the timeline is completely muted during render-as-you-go playback because audio scheduling is strictly gated on every single frame in the work area being cached in RAM first, and any single missing or evicted frame immediately halts audio.

---

### 9. Project Persistence (Ctrl+S) Spawns Incremental Browser Downloads Instead of Overwriting File
- **Location:** `src/state/projectIO.ts` (L10–26, L51–60), `src/ui/commands.ts` (L41–42)
- **Severity:** High (Data Management / Project Duplication)
- Saving via Ctrl+S creates an ephemeral browser download link that saves duplicate copies to the user's Downloads folder instead of using the File System Access API to overwrite the existing file on disk.

---

### 10. Keyframe Graph Editor Value Drag Exponential Runaway Acceleration
- **Location:** `src/ui/timeline/GraphEditor.tsx` (L141–150, L400–415)
- **Severity:** High (Timeline Control Breakdown)
- Dragging keyframes vertically recalculates the value scale on each state update, which compounds the drag delta against an expanding range and causes keyframe values to violently accelerate and jitter.

---

### 11. Pen Tool Open Path on Active Layer Spawns Duplicate Shape Layer Instead of Mask
- **Location:** `src/ui/viewer/ViewPane.tsx` (L966–980)
- **Severity:** High (Layer Hierarchy Corruption)
- Pressing Enter to finalize an open pen path on an existing footage or solid layer bypasses mask creation and inadvertently spawns a new shape layer because the code requires paths to be closed to attach as masks.

---

### 12. Precompose "Leave All Attributes" Omits Masks and Effects
- **Location:** `src/state/actions.ts` (L1028–1032), `src/ui/shell/Dialogs.tsx` (L419)
- **Severity:** High (Composition Data Inconsistency)
- Precomposing a layer with "Leave all attributes" enabled only copies the transform to the outer layer, silently leaving masks and effects inside the nested composition contrary to user settings.

---

### 13. `splitLayers` Breaks Parenting and Track Matte References
- **Location:** `src/state/actions.ts` (L591–600)
- **Severity:** High (Timeline Hierarchy Desync)
- Splitting layers generates new layer IDs for the second half of the timeline without remapping `parentId` or `trackMatte.layerId`, breaking parenting relationships and matte links for all split segments.

---

### 14. Disabled Menu Items Execute Bound Actions on Click
- **Location:** `src/ui/controls/Menu.tsx` (L25–33)
- **Severity:** High (Illegal Action Invocation)
- The menu click handler omits a disabled check, allowing users to click visually inactive menu options and execute unauthorized or invalid actions.

---

### 15. Keyframe Graph Editor Drag Ignores Multi-Selection
- **Location:** `src/ui/timeline/GraphEditor.tsx` (L405–409)
- **Severity:** Medium (Workflow Inconsistency)
- Dragging keyframes in the graph editor only updates the single keyframe under the cursor, leaving all other selected keyframes stationary.

---

### 16. Time Remapping Unconditionally Mutes Layer Audio
- **Location:** `src/audio/engine.ts` (L83, L93)
- **Severity:** Medium (Audio Playback & Export Silencing)
- The audio mixer explicitly skips any layer with time remapping enabled, completely silencing its audio playback and export rather than playing at baseline speed or resampling.

---

### 17. WebGL Texture Pool Pruning Memory Accounting Desync on `rgba32f`
- **Location:** `src/render/gl/gl.ts` (L407)
- **Severity:** Medium (Phantom Memory Leak / Budget Exhaustion)
- When freeing 32-bit floating-point textures from the pool, memory accounting subtracts only 4 bytes per pixel instead of 16, resulting in a phantom memory leak that prematurely exhausts the GPU cache budget.

---

### 18. Graph Editor Omits Bezier Handles for Spatial Properties in Value Mode
- **Location:** `src/ui/timeline/GraphEditor.tsx` (L164–165)
- **Severity:** Medium (UI Feature Omission)
- Switching the value graph editor to spatial properties completely hides tangent handles, preventing users from editing spatial interpolation curves visually.

---

### 19. Speed Graph Negative Speeds and Tangent Hit-Test Ambiguity
- **Location:** `src/ui/timeline/GraphEditor.tsx` (L355–360, L435–455)
- **Severity:** Medium (Animation Curve Inaccuracy)
- Speed graph handle dragging fails to clamp speeds to non-negative values and confuses overlapping incoming and outgoing tangents at sharp keyframe transitions.

---

### 20. Pen Tool Missing Vertex Manipulation and Tangent Modification Controls
- **Location:** `src/ui/viewer/ViewPane.tsx` (L924–955)
- **Severity:** Medium (Tool Polish Deficit)
- The pen tool only supports sequential point placement without the ability to select, move, delete, or convert existing vertices and closing tangents.

---

### 21. Scrub Sensitivity Modifier Leaps on Shift/Ctrl Press
- **Location:** `src/ui/controls/Scrub.tsx` (L125–126)
- **Severity:** Low (Input Value Jump)
- Toggling Shift or Ctrl during numeric scrub dragging multiplies the total drag displacement from the origin rather than the movement delta, causing the value to suddenly leap tenfold.

---

### 22. `deleteProjectItems` Leaves Empty Composition Tab Bar
- **Location:** `src/state/actions.ts` (L1067–1071)
- **Severity:** Low (State Inconsistency / Tab Bar Desync)
- Deleting all open compositions when other unopened compositions exist updates `activeCompId` but forgets to add it to `openComps`, leaving the editor without any open tabs.

---

### 23. Curves Editor Missing Y-Range Clamping and Alpha Channel Background Curve
- **Location:** `src/ui/controls/CurvesEditor.tsx` (L54, L107)
- **Severity:** Low (Input Clamping & Visual Omission)
- Dragging curves editor points past the boundary generates unclamped values outside $[0, 1]$, and the preview canvas omits the alpha curve from the background channel display.
