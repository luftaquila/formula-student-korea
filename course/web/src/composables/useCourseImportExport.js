import { ref } from "vue";
import { request } from "../api.js";
import { buildCourseArchive, downloadCourseArchive } from "../export/course-archive.mjs";

// Operator import/export owns API access; archive generation is shared with the
// public viewer, which supplies its own annotation-free data from public APIs.
export function useCourseImportExport({ courses, conesMap, memosMap, routeMap, activeCourseId, newCourseName, notifyError }) {
  const importInput = ref(null);
  const exportingId = ref(null);

  async function exportCourse(id) {
    if (exportingId.value) return;
    const course = courses.value.find((c) => c.id === id);
    if (!course) return;
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
      const archive = await buildCourseArchive({ course, cones, memos, route: routeConfig }, { includeMemos: true });
      downloadCourseArchive(archive);
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
    } catch (err) {
      notifyError(err.message);
    }
  }

  return { importInput, exportingId, exportCourse, triggerImport, importCourse };
}
