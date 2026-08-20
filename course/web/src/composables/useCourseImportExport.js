import { ref } from "vue";
import { request } from "../api.js";
import { computeCenterline } from "@lib/centerline.mjs";
import { buildRoadEdges } from "@lib/road-edges.mjs";
import { buildTrackModel } from "@lib/track-build.mjs";
import { computeGuidedRoute } from "@lib/guided-route.mjs";
import { buildGuidedTrackModel } from "@lib/guided-track-build.mjs";
import { packTrackEntries, safeTrackName } from "@lib/pack-track.mjs";
import { buildEnrichedJSON, buildGuidedEnrichedJSON } from "@lib/course-export.mjs";
import { renderTwoPanelPNG } from "../export/panel-canvas.js";
import JSZip from "jszip";

// Course ZIP export / JSON import, extracted from MapView. The whole export
// pipeline (centerline → road edges → AC track model → preview PNG → zip) runs
// client-side. Deps injected by the view:
//   courses/conesMap/memosMap  reactive course data (refs)
//   activeCourseId/visibility/newCourseName  view state written on import
//   courseDirOpts(id, cones)   centerline start/direction opts (shared with the map)
//   notifyError(msg)           toast on failure
export function useCourseImportExport({ courses, conesMap, memosMap, routeMap, activeCourseId, visibility, newCourseName, courseDirOpts, notifyError }) {
  const importInput = ref(null);
  const exportingId = ref(null);
  // Fixed per-file timestamp so a re-export of the same course is reproducible
  // (JSZip otherwise stamps the current time into every entry).
  const EXPORT_DATE = new Date("2020-01-01T00:00:00Z");

  // Export a course as a ZIP holding three items:
  //   <name>.json        enriched, re-importable course record (every numeric artifact)
  //   <name>_width.png   2-panel preview (centerline | road width)
  //   <name>_track.zip   installable Assetto Corsa track (extracts into AC content/)
  async function exportCourse(id) {
    if (exportingId.value) return;
    const course = courses.value.find((c) => c.id === id);
    const name = course?.name || "course";       // in-game display name (kept as-is)
    const safeName = safeTrackName(name);         // path-safe base for file/folder names
    exportingId.value = id;
    try {
      // cones: prefer the already-loaded map, else fetch (allows a non-active course)
      let cones = conesMap.value[id];
      if (!cones || !cones.length) {
        const res = await request(`/api/courses/${id}/cones`);
        cones = await res.json();
      }

      // Memos and route markers are captured too, so the enriched JSON remains
      // a complete export→import round-trip rather than a cone-only archive.
      let memos = memosMap.value[id];
      if (!memos) {
        try { memos = await (await request(`/api/courses/${id}/memos`)).json(); } catch { memos = []; }
      }

      let routeConfig = routeMap.value[id];
      if (!routeConfig) {
        try { routeConfig = await (await request(`/api/courses/${id}/route`)).json(); }
        catch { routeConfig = { markers: [], steps: [] }; }
      }
      const guided = Array.isArray(routeConfig.steps) && routeConfig.steps.length >= 2;
      let cl, edges, track;
      if (guided) {
        cl = computeGuidedRoute(cones, routeConfig.markers, routeConfig.steps, { step: 1.0 });
        edges = null;
        track = buildGuidedTrackModel(cl, cones, { name: safeName });
      } else {
        // same start/direction as the on-map centerline so the export matches
        cl = computeCenterline(cones, { step: 1.0, metric: true, ...courseDirOpts(id, cones) });
        if (!cl.ok) { notifyError(`중심선 생성 실패: ${cl.reason}`); return; }
        edges = buildRoadEdges(cl);   // AC track road: widened +1 m/side (except slalom)
        track = buildTrackModel(cl, edges, { name: safeName });
      }

      // inner Assetto Corsa track zip (content/tracks/<safeName>/...); the in-game
      // UI name (ui_track.json) keeps the original, spaces and all.
      const entries = packTrackEntries(cl, edges, track, { name: safeName, uiName: name });
      const trackZip = new JSZip();
      for (const [path, content] of Object.entries(entries)) {
        trackZip.file(path, content, { date: EXPORT_DATE });
      }
      const trackZipBlob = await trackZip.generateAsync({ type: "blob", compression: "DEFLATE" });

      const enriched = guided
        ? buildGuidedEnrichedJSON({ name, cones, memos, route: cl, track })
        : buildEnrichedJSON({ name, cones, memos, cl, edges, track });
      // A guided surface has no single left/right ribbon; use the exact AC minimap
      // raster. Legacy previews retain the cone-true two-panel rendering.
      const png = guided
        ? entries[`content/tracks/${safeName}/map.png`]
        : await renderTwoPanelPNG(cl, buildRoadEdges(cl, { extraWidthPerSide: 0 }), { name });

      // outer zip with the three deliverables (path-safe file names)
      const outer = new JSZip();
      outer.file(`${safeName}.json`, JSON.stringify(enriched), { date: EXPORT_DATE });
      outer.file(`${safeName}.png`, png, { date: EXPORT_DATE });
      outer.file(`${safeName}-track.zip`, trackZipBlob, { date: EXPORT_DATE });
      const blob = await outer.generateAsync({ type: "blob", compression: "DEFLATE" });

      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${safeName}.zip`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (err) {
      notifyError(err?.message || String(err));
    } finally {
      exportingId.value = null;
    }
  }

  function triggerImport() {
    if (!newCourseName.value.trim()) return;
    importInput.value?.click();
  }

  async function importCourse(e) {
    const file = e.target.files[0];
    if (!file) return;
    e.target.value = "";
    // The imported course takes the name typed in the new-course input, not the
    // name baked into the file — so the operator names it on the spot and avoids
    // UNIQUE collisions with an existing course of the same exported name.
    const name = newCourseName.value.trim();
    if (!name) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      const res = await request("/api/courses/import", {
        method: "POST",
        body: JSON.stringify({
          name,
          cones: data.cones,
          memos: data.memos,
          reverse: data.reverse,
          start_cone_index: data.start_cone_index,
          route_markers: data.route_markers,
          route_steps: data.route_steps,
        }),
      });
      const created = await res.json();
      newCourseName.value = "";
      activeCourseId.value = created.id;
      visibility.value[created.id] = true;
    } catch (err) {
      notifyError(err.message);
    }
  }

  return { importInput, exportingId, exportCourse, triggerImport, importCourse };
}
