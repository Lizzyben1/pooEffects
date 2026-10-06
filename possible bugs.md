# Comprehensive Bug & Error Scan Report (`possible bugs`)

## Overview

This report documents the detected bugs, algorithmic flaws, and edge-case errors discovered during an in-depth scan of the **pooEffects** codebase. Per instructions, **no bugs have been fixed or modified** in the source files.

Each entry includes the affected file path(s), exact line numbers, root cause analysis, real-world impact, reproduction conditions, and a **confidence score** representing certainty that the issue is a genuine software bug.

---

## 1. UI & Controls: Context Menu Submenu Pointerdown Premature Dismissal

- **Affected Files:**
  - `src/ui/controls/Popover.tsx` (Lines 32–42)
  - `src/ui/controls/Menu.tsx` (Lines 25–46)
- **User-Reported Symptom:** *"The right click menu buttons don't work unless you do the command."*
- **Confidence Score:** **100%**
- **Root Cause Analysis:**
  - Context menus and their cascading submenus (e.g., *New Layer*, *Effects*, *Transform*, *Masks*) are displayed using `Popover`, which mounts each menu into `document.body` via React's `createPortal(..., document.body)`.
  - In `Popover.tsx`, an outside-click detection listener is attached to the window during the capture phase on `pointerdown`:
    ```typescript
    const down = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    window.addEventListener('pointerdown', down, true);
    ```
  - When a user hovers over an item with a submenu (e.g., "New"), a secondary child `Popover` is rendered into `document.body`. Because both the parent menu and child submenu are portaled directly to `document.body`, they are DOM siblings rather than DOM children of each other.
  - When the user clicks any item inside the child submenu, `e.target` is within the submenu's DOM tree, so `ref.current.contains(e.target)` in the **parent** popover evaluates to `false`.
  - The parent `Popover`'s capture listener catches the `pointerdown` event immediately and calls `onClose()`, unmounting both the parent context menu and the child submenu before the browser can dispatch `pointerup` or `click`.
  - Consequently, the submenu item's `onClick` handler (`it.action?.()`) is never invoked. Users are forced to rely on keyboard shortcuts to execute these commands.

---

## 2. Engine & Cache: Renderer / Playback Deadlock Between `hasRoom()` and Eviction

- **Affected Files:**
  - `src/state/cache.ts` (Lines 123–132, 167–169)
  - `src/state/playback.ts` (Line 127)
  - `src/state/engine.ts` (Line 115)
- **User-Reported Symptom:** *"Sometimes the renderer doesn't render and you must clear cache."*
- **Confidence Score:** **100%**
- **Root Cause Analysis:**
  - The cache LRU eviction mechanism only runs inside `cache.put()` when `totalBytes > budgetBytes()`:
    ```typescript
    put(entry: CacheEntry): boolean {
      ...
      this.totalBytes += entry.bytes;
      while (this.totalBytes > this.budgetBytes() && this.entries.size > 0) {
        this.evictOldest();
      }
    }
    ```
  - However, both `playback.ts` (during timeline playback) and `engine.ts` (during frame prefetching) guard rendering with `hasRoom()` checks:
    ```typescript
    // playback.ts line 127:
    if (!cache.hasRoom(estBytes)) break;

    // engine.ts line 115:
    if (!cache.hasRoom(est)) return;
    ```
  - In `cache.ts`, `hasRoom()` checks:
    ```typescript
    hasRoom(additionalBytes: number): boolean {
      return this.totalBytes + additionalBytes <= this.budgetBytes() * 0.98;
    }
    ```
  - When rendering frames fills the cache up to ~90–98% of the RAM budget, `hasRoom()` returns `false`.
  - Because `hasRoom()` returns `false`, `playback.ts` breaks out of the render loop and `engine.ts` aborts rendering requests before sending them to the worker.
  - Since no render requests are sent to the worker, no completed frames are returned to `cache.put()`. Because `cache.put()` is never called, `evictOldest()` never executes.
  - The entire rendering pipeline reaches a deadlock: it will not render new frames because the cache is nearly full, but the cache will not evict old frames because no new frames are being rendered. The user is forced to manually click "Purge RAM Cache" (`cache.purgeAll()`) to escape the deadlock.

---

## 3. Timeline & Graph Editor: Value Drag Exponential Acceleration and Jitter

- **Affected Files:**
  - `src/ui/timeline/GraphEditor.tsx` (Lines 141–150, 400–415)
- **User-Reported Symptom:** *"The graph thing for keyframes is very unpolished."*
- **Confidence Score:** **95%**
- **Root Cause Analysis:**
  - In `GraphEditor.tsx`, vertical dragging maps pointer pixel positions to property values via `vOf(y, range)`:
    ```typescript
    const vOf = (py: number, r = yRange.current) => r.max - ((py - PADDING_TOP) / Math.max(1, innerH)) * (r.max - r.min);
    ```
  - During a keyframe drag, each `pointermove` event dispatches an action to update the keyframe value:
    ```typescript
    const v = s.v0 + (vOf(e.clientY) - s.vy0);
    A.setKeyframeValue(comp.id, key, [v], [dim]);
    ```
  - Calling `A.setKeyframeValue` immediately updates the state store, triggering a React re-render of `GraphEditor`.
  - On re-render, lines 141–150 recalculate `yRange.current` to enclose all keyframe values, expanding `[yRange.min, yRange.max]` if the new value exceeds the previous bounds.
  - On the very next `pointermove` event, `vOf(e.clientY)` evaluates against the newly expanded `yRange.current`, but computes the delta relative to the initial drag position `s.vy0` (which was calculated against the old range).
  - This causes positive feedback / runaway value acceleration: moving the mouse by 1 pixel expands the range, which makes the next pixel move worth exponentially more, causing keyframe values to fly off to extreme numbers or jitter uncontrollably.

---

## 4. Timeline & Graph Editor: Multi-Keyframe Selection Bypass During Drag

- **Affected Files:**
  - `src/ui/timeline/GraphEditor.tsx` (Lines 405–409)
- **User-Reported Symptom:** Keyframe graph editor fails standard multi-selection editing workflows.
- **Confidence Score:** **95%**
- **Root Cause Analysis:**
  - In the Timeline panel, users can marquee-select or shift-click multiple keyframes across properties.
  - However, in `GraphEditor.tsx`, the drag handler is hardcoded to only update the single keyframe under the cursor:
    ```typescript
    const key = s.prop.keyframes[s.idx];
    if (key) {
      const dim = s.prop.type === 'position' || s.prop.type === 'point' ? s.dim : undefined;
      A.setKeyframeValue(comp.id, key, [v], [dim]);
    }
    ```
  - None of the other currently selected keyframes are updated or translated in value/time. The single dragged keyframe moves while all other selected keyframes remain stationary, breaking multi-keyframe adjustment workflows.

---

## 5. Timeline & Graph Editor: Missing Bezier Handles on Spatial Properties in Value Graph

- **Affected Files:**
  - `src/ui/timeline/GraphEditor.tsx` (Lines 164–165)
- **Confidence Score:** **95%**
- **Root Cause Analysis:**
  - In `computeSeries()` in `GraphEditor.tsx`:
    ```typescript
    // spatial properties ease distance, not components; handles live in the speed graph
    if (s.spatial) return out;
    ```
  - While spatial properties (Position, Anchor Point) use distance-based easing along spatial curves, the Value Graph editor completely skips generating handle controls for spatial properties.
  - When switching the Graph Editor to "Value Graph" view on a 2D/3D Position property, no tangent handles are rendered on keyframes, making it impossible to adjust value curves or temporal interpolation visually in Value Graph mode.

---

## 6. Timeline & Graph Editor: Speed Graph Negative Speeds and Tangent Hit-Test Ambiguity

- **Affected Files:**
  - `src/ui/timeline/GraphEditor.tsx` (Lines 355–360, 435–455)
- **Confidence Score:** **92%**
- **Root Cause Analysis:**
  - In Speed Graph mode, speed represents scalar magnitude ($\text{units}/\text{second}$) and must be strictly non-negative ($\ge 0$).
  - When dragging speed handles vertically in `GraphEditor.tsx`, the speed delta calculation allows the value to drop below zero, assigning negative speed to `easeIn.speed` or `easeOut.speed`.
  - Furthermore, at sharp keyframe transitions where incoming and outgoing speeds have identical or overlapping control points, hit-testing does not disambiguate between `inHandle` and `outHandle`, resulting in the wrong tangent handle being grabbed and dragging artifacts.
  - Right-clicking an unselected keyframe also opens the context menu without selecting the clicked keyframe first, applying easing presets to the previously selected keyframes instead of the intended one.

---

## 7. Viewer & Vector Tools: Pen Tool Screen Coordinate Distortion on Pan / Zoom

- **Affected Files:**
  - `src/ui/viewer/ViewPane.tsx` (Lines 926, 946–952)
- **User-Reported Symptom:** *"The pen tool doesn't work well."*
- **Confidence Score:** **100%**
- **Root Cause Analysis:**
  - In `ViewPane.tsx`, while drawing a path with the Pen tool, points are captured and stored in raw screen pixel coordinates `[sx, sy]` in `pen.pts`:
    ```typescript
    pen.pts.push({ v: [sx, sy], i: [0, 0], o: [0, 0] });
    ```
  - Users frequently pan (holding Middle Mouse or Space + Drag) or zoom (mouse wheel) the viewer while placing pen anchor points on high-resolution graphics.
  - When the path is finalized (e.g., closing the path or pressing Enter), the conversion from screen coordinates to composition space occurs all at once using the *current* viewer transform:
    ```typescript
    const compPts = pen.pts.map((pt) => ({
      v: screenToComp(pt.v),
      i: screenVecToComp(pt.i),
      o: screenVecToComp(pt.o),
    }));
    ```
  - If the user panned or zoomed at any point while drawing, `screenToComp` uses the new pan offset and zoom scale for all earlier points. The coordinates of all points drawn prior to panning/zooming are drastically distorted and misplaced in composition space.

---

## 8. Viewer & Vector Tools: Finalizing Open Path on Non-Shape Layer Unintentionally Creates New Shape Layer

- **Affected Files:**
  - `src/ui/viewer/ViewPane.tsx` (Lines 966–980)
- **User-Reported Symptom:** Open mask creation with the Pen tool malfunctions.
- **Confidence Score:** **95%**
- **Root Cause Analysis:**
  - When drawing a mask on an active layer (e.g., a Video footage, Solid, or Image layer), users frequently create open paths (e.g., for stroke effects or open masks) by pressing Enter.
  - In `ViewPane.tsx`, path finalization checks:
    ```typescript
    if (activeLayer && closed) {
      A.addMask(comp.id, activeLayer.id, { path, mode: 'add' });
    } else {
      // Creates a new Shape Layer
      A.addShapeLayer(comp.id, ...);
    }
    ```
  - Because `closed` is false for an open path, the condition `if (activeLayer && closed)` evaluates to `false`.
  - Instead of adding an open mask to `activeLayer`, the code falls through to the `else` branch and creates a brand-new, empty Shape Layer containing the path. This corrupts the user's layer hierarchy and leaves the intended layer without a mask.

---

## 9. Viewer & Vector Tools: Missing Vertex Selection, Movement, and Tangent Controls on Pen Tool

- **Affected Files:**
  - `src/ui/viewer/ViewPane.tsx` (Lines 924–955)
- **User-Reported Symptom:** Pen tool lacks standard vector drawing interaction and polish.
- **Confidence Score:** **95%**
- **Root Cause Analysis:**
  - The Pen tool in `ViewPane.tsx` is implemented solely as an append-only state machine.
  - It does not support:
    1. Selecting or repositioning existing vertices after placing them.
    2. Deleting unwanted vertices (Delete/Backspace).
    3. Tangent conversion (Alt-click / Convert Vertex Tool) to toggle between smooth and corner points.
    4. Dragging out bezier handles on the final closing vertex (when clicking the start point to close a path, it hardcodes tangents to `[0, 0]`).
  - Any mistake during drawing requires the user to cancel the entire path and restart from scratch.

---

## 10. Engine & Cache: `renderForView` Discards Rendered Frames & Blanks Canvas on Cache Put Rejection

- **Affected Files:**
  - `src/state/engine.ts` (Lines 70–75)
  - `src/ui/viewer/ViewPane.tsx` (Lines 213–216)
- **Confidence Score:** **98%**
- **Root Cause Analysis:**
  - When `renderForView()` receives a rendered `ImageBitmap` from the render worker, it attempts to insert it into the cache:
    ```typescript
    const ok = cache.put({ ...entry, bmp: r.bitmap });
    if (!ok) return null;
    return r;
    ```
  - In `cache.ts`, `cache.put()` can return `false` if the frame's project signature doesn't match current state (e.g., rapid user scrubbing or parameter edits in progress). When `cache.put()` rejects, it calls `entry.bmp.close()` and returns `false`.
  - In response, `renderForView()` returns `null` instead of returning the freshly rendered frame directly to the UI.
  - In `ViewPane.tsx`, when `renderForView` resolves to `null`, it takes no action:
    ```typescript
    void renderForView(comp.id, time, opts).then((r) => {
      if (!r) return;
      ...
    });
    ```
  - This causes the canvas to drop valid frames during active scrubbing and interactive edits, resulting in flickering, frozen frames, or a blank canvas.

---

## 11. Engine & Cache: Evicted Cache ImageBitmaps Crash Viewer with `InvalidStateError`

- **Affected Files:**
  - `src/ui/viewer/ViewPane.tsx` (Lines 139–144)
  - `src/state/cache.ts` (Line 65)
- **Confidence Score:** **98%**
- **Root Cause Analysis:**
  - When the cache evicts an old entry (`evictOldest()`) or purges a composition (`dropComp()`), it closes the associated bitmap: `e.bmp.close()`.
  - However, `ViewPane.tsx` retains a direct reference to the current displayed bitmap:
    ```typescript
    img.current.bmp = r.bitmap;
    ```
  - If a background prefetch or cache eviction closes `r.bitmap` while `ViewPane` is still displaying it, any subsequent canvas redraw (triggered by panning, zooming, or window resizing) calls:
    ```typescript
    ctx.drawImage(img.current.bmp, ...);
    ```
  - Calling `drawImage` on a closed `ImageBitmap` throws an `InvalidStateError` DOMException in all major browsers.
  - The catch block in `ViewPane.tsx` catches the exception and resets `img.current.bmp = null`, causing the viewer canvas to suddenly turn completely black/blank.

---

## 12. Export Engine: Missing `convertToBlob` on `HTMLCanvasElement` in Inline Export Fallback

- **Affected Files:**
  - `src/export/exporter.ts` (Line 130)
  - `src/render/host.ts` (Line 93)
- **Confidence Score:** **100%**
- **Root Cause Analysis:**
  - When running in environments where Web Workers or `OffscreenCanvas` are unavailable, `host.ts` falls back to the main thread inline renderer:
    ```typescript
    () => (typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(16, 16) : document.createElement('canvas'))
    ```
  - If `document.createElement('canvas')` is instantiated, the underlying canvas is an `HTMLCanvasElement`.
  - In `exporter.ts` during PNG sequence export:
    ```typescript
    const canvas = renderer.glc.canvas as OffscreenCanvas;
    ...
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    ```
  - `convertToBlob` is an API exclusive to `OffscreenCanvas`. On an `HTMLCanvasElement`, this method is `undefined`.
  - Invoking `canvas.convertToBlob()` throws an unhandled `TypeError: canvas.convertToBlob is not a function`, crashing the export worker immediately without generating the PNG sequence.

---

## 13. State Management: Precompose "Leave All Attributes" Omits Masks and Effects

- **Affected Files:**
  - `src/state/actions.ts` (Lines 1028–1032)
  - `src/ui/shell/Dialogs.tsx` (Line 419)
- **Confidence Score:** **100%**
- **Root Cause Analysis:**
  - The Precompose dialog explicitly offers the user the option:
    > *"Leave all attributes in 'CompName' — Keeps transforms, effects and masks on the new precomp layer."*
  - However, in `src/state/actions.ts`:
    ```typescript
    if (leaveAttributes && sel.length === 1) {
      const src = comp.layers.find((l) => l.id === sel[0])!;
      precompLayer.transform = clone(src.transform);
      // Masks and effects are completely omitted!
    }
    ```
  - Only `transform` is copied to `precompLayer`. `masks` and `effects` are left inside the nested composition.
  - This contradicts the documented UI behavior and breaks composition hierarchy when users expect effects and masks to apply to the precomp container.

---

## 14. Controls & UI: Disabled Menu Items Execute Bound Actions on Click

- **Affected Files:**
  - `src/ui/controls/Menu.tsx` (Lines 25–33)
- **Confidence Score:** **100%**
- **Root Cause Analysis:**
  - In `MenuList`, clicking a menu item executes:
    ```typescript
    onClick={(e) => {
      e.stopPropagation();
      if (hasSub) {
        setSub({ idx: i, rect: (e.currentTarget as HTMLElement).getBoundingClientRect() });
        return;
      }
      onClose();
      it.action?.();
    }}
    ```
  - The click handler never checks `if (it.disabled) return;`.
  - Even though disabled items are rendered with CSS opacity (`menu-item disabled`), clicking them still dismisses the menu and executes `it.action()`.
  - Users can invoke disabled actions (such as Undo/Redo when history is empty, or layer actions when no layers are selected).

---

## 15. Controls & UI: Scrub Sensitivity Multipliers Cause Value Jumps on Modifier Press

- **Affected Files:**
  - `src/ui/controls/Scrub.tsx` (Lines 125–126)
- **Confidence Score:** **95%**
- **Root Cause Analysis:**
  - In `Scrub.tsx`, dragging a numeric input applies sensitivity modifiers (Shift for 10× speed, Ctrl for 0.1× precision):
    ```typescript
    const mult = e.shiftKey ? 10 : e.ctrlKey ? 0.1 : 1;
    const v = s.v0 + dx * s.step * mult;
    ```
  - `dx` is the total distance from the initial click: `dx = e.clientX - s.x0`.
  - Because `mult` is multiplied against the total displacement `dx` rather than applied incrementally per mouse movement delta, pressing or releasing Shift midway through a drag instantly multiplies the accumulated displacement tenfold.
  - The numeric value leaps drastically, disrupting fine adjustment.

---

## 16. State Management: `splitLayers` Breaks Layer Parenting and Track Matte References

- **Affected Files:**
  - `src/state/actions.ts` (Lines 591–600)
- **Confidence Score:** **92%**
- **Root Cause Analysis:**
  - When splitting layers at the current time (`splitLayers()`), each selected layer is duplicated into a right-hand segment with a new generated ID (`uid('layer')`).
  - Unlike `duplicateLayers()`, `splitLayers()` does not create an ID translation map (`idMap`).
  - As a result:
    1. If layer B is parented to layer A (`parentId: A.id`), splitting both layers leaves the split segment of layer B parented to the original layer A rather than the new split segment of layer A.
    2. If a layer uses a track matte (`trackMatte.layerId`), splitting layers leaves the split matte pointing to the old layer ID.
  - This breaks hierarchy relationships for all split segments in the second half of the timeline.

---

## 17. 3D Camera Tracking: Ground Plane Singular Degeneracy When Plane Normal is Along X-Axis

- **Affected Files:**
  - `src/state/tracking.ts` (Lines 939–943)
  - `src/cv/linalg.ts` (Line 271)
- **Confidence Score:** **95%**
- **Root Cause Analysis:**
  - When defining a ground plane from selected 3D tracking points, the rotation matrix constructs a tangent vector $u$ perpendicular to normal $n$ by projecting $[1, 0, 0]$:
    ```typescript
    const u = normalize3(sub3([1, 0, 0], scale3(n, dot3([1, 0, 0], n))));
    ```
  - If the selected ground plane normal $n$ is parallel to $[1, 0, 0]$ (i.e., $n = [\pm 1, 0, 0]$):
    $$\text{dot3}([1, 0, 0], n) = \pm 1$$
    $$\text{scale3}(n, \pm 1) = [1, 0, 0]$$
    $$\text{sub3}([1, 0, 0], [1, 0, 0]) = [0, 0, 0]$$
  - Calling `normalize3([0, 0, 0])` divides by zero, returning `[NaN, NaN, NaN]`.
  - All subsequent matrix operations produce `NaN`, corrupting camera rotation, orientation, and layer placement for any wall or vertical plane aligned with the X-axis.

---

## 18. UI Controls: Curves Editor Unclamped Y-Range and Missing Alpha Curve Background

- **Affected Files:**
  - `src/ui/controls/CurvesEditor.tsx` (Lines 54, 107)
- **Confidence Score:** **90%**
- **Root Cause Analysis:**
  - In `CurvesEditor.tsx`, dragging control points vertically maps client coordinates to curve values without clamping to `[0, 1]`:
    ```typescript
    const y = 1 - (e.clientY - r.top) / r.height;
    ```
  - Users can drag points outside the visual box, creating negative color curve values or values $> 1$, which produces color clamping artifacts and unexpected RGB clipping in effects.
  - In addition, the background curve preview renderer draws curves for Red, Green, and Blue, but completely omits the Alpha curve, leaving the user with no visual reference when editing the Alpha channel curve.

---

## 19. State Management: `deleteProjectItems` Desynchronizes `openComps` State

- **Affected Files:**
  - `src/state/actions.ts` (Lines 1067–1071)
- **Confidence Score:** **90%**
- **Root Cause Analysis:**
  - In `deleteProjectItems()`, when compositions are deleted from the project panel:
    ```typescript
    if (!openComps.includes(activeCompId)) {
      const remaining = openComps[0] ?? Object.keys(project.comps)[0] ?? null;
      setApp({ activeCompId: remaining });
    }
    ```
  - If all open compositions are closed/deleted, but other compositions exist in `project.comps`, `activeCompId` is set to `Object.keys(project.comps)[0]`.
  - However, `openComps` is never updated to include this new `activeCompId`.
  - The application enters an inconsistent state where an active composition is set, but `openComps` is empty, resulting in no composition tabs displayed in the UI tab bar.

---

## 20. WebGL Renderer: Texture Pool Deallocation Under-Accounting for `rgba32f` Format

- **Affected Files:**
  - `src/render/gl/gl.ts` (Line 407)
- **Confidence Score:** **95%**
- **Root Cause Analysis:**
  - In `GLContext.endFrame()`, when pruning the texture pool to stay within memory limits:
    ```typescript
    this.poolBytes -= t.w * t.h * (t.format === 'rgba16f' ? 8 : 4);
    ```
  - The renderer supports three formats: `rgba8` (4 bytes/px), `rgba16f` (8 bytes/px), and `rgba32f` (16 bytes/px, used for 32-bit float HDR compositions).
  - For `rgba32f`, the ternary operator falls through to the default branch (`4` bytes) instead of subtracting `16` bytes per pixel.
  - Every time an `rgba32f` texture is pruned from the pool, `poolBytes` retains a phantom residual of 12 bytes per pixel. Over time, `poolBytes` artificially inflates until the renderer believes its memory budget is permanently exhausted, causing it to discard textures unnecessarily.

---

## 21. Audio Engine: Time Remapping Mutes Layer Audio Playback and Export

- **Affected Files:**
  - `src/audio/engine.ts` (Lines 83, 93)
- **Confidence Score:** **90%**
- **Root Cause Analysis:**
  - In `mixdown()` in `src/audio/engine.ts`:
    ```typescript
    if (l.timeRemapEnabled) continue;
    ```
  - The audio mixer deliberately skips any layer where time remapping is enabled.
  - When a user enables Time Remapping on a video or audio clip, the audio track is muted entirely during both real-time playback and video export, rather than playing at baseline speed or pitch/time-shifting according to the remapping curve.

---

## 22. Audio Engine & Playback: Timeline Audio Playback Gated Exclusively on 100% RAM Cache Completion

- **Affected Files:**
  - `src/state/playback.ts` (Lines 51–77, 98–99, 153–177)
  - `src/audio/engine.ts` (Lines 132–151)
- **User-Reported Symptom:** *"Audio on the timeline doesn't play sometimes."*
- **Confidence Score:** **100%**
- **Root Cause Analysis:**
  - In `playback.ts`, audio playback is strictly tied to `beginRealtime()`:
    ```typescript
    function beginRealtime(s: PlayState, now: number): void {
      ...
      if (comp && !muted && compHasAudio(app.project, comp)) {
        s.audioWhen0 = playComp(app.project, comp, s.frame / s.fps, (s.last + 1) / s.fps);
        s.audio = true;
      }
    }
    ```
  - However, `beginRealtime()` is only invoked when `allCached(st)` is true:
    ```typescript
    if (allCached(st)) beginRealtime(st, performance.now());
    ```
  - `allCached()` requires every single frame between `first` and `last` in the work area to already reside in the RAM cache.
  - When a user starts playback on any section of the timeline that hasn't finished rendering to RAM cache (render-as-you-go mode), `beginRealtime()` is never called, so `playComp()` never runs and audio is completely muted.
  - Furthermore, if playback is running in realtime mode and any single frame is evicted or missed, `endRealtime()` is immediately called (line 168), which executes `stopAudio()` and permanently cuts audio playback.
  - If a composition's length/resolution exceeds available cache capacity (preventing `allCached()` from ever becoming true), audio will never play at all during timeline playback.

---

## 23. Project Persistence: Save (Ctrl+S) Spawns Incremental Browser Downloads Instead of Overwriting Existing File

- **Affected Files:**
  - `src/state/projectIO.ts` (Lines 10–26, 51–60)
  - `src/ui/commands.ts` (Lines 41–42)
- **User-Reported Symptom:** *"When you press Ctrl+S it doesn't save the existing file, it downloads a new one every time."*
- **Confidence Score:** **100%**
- **Root Cause Analysis:**
  - In `projectIO.ts`, `saveProjectFile()` implements project saving using an ephemeral `<a>` tag download:
    ```typescript
    export async function saveProjectFile(): Promise<void> {
      ...
      const name = (s.fileName ?? p.name ?? 'Untitled').replace(/\.pooe$/i, '') + '.pooe';
      downloadBlob(blob, name);
      setApp({ dirty: false, fileName: name });
    }

    export function downloadBlob(blob: Blob, name: string): void {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
    }
    ```
  - Because saving relies on browser file downloads rather than the File System Access API (`showSaveFilePicker` / `FileSystemFileHandle.createWritable()`), the browser treats every save as a separate downloaded file.
  - Standard browser behavior does not silently overwrite files in the user's Downloads folder; instead, it automatically appends incremental suffixes (`project.pooe`, `project (1).pooe`, `project (2).pooe`).
  - Furthermore, when opening a project via `openProjectFile()`, it uses `<input type="file">`, which only provides read-only `File` streams without retaining a writable file handle.
  - Consequently, hitting Ctrl+S repeatedly clutters the user's Downloads folder with dozens of duplicate incremental files rather than saving changes directly to the opened project file.
