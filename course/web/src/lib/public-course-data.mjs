// Load a view snapshot on entry or explicit refresh; never poll or subscribe.
export function createPublicCourseData(state, { request }) {
  let generation = 0;
  let controller = null;
  let disposed = false;

  function invalidate() {
    generation += 1;
    controller?.abort();
    state.details = {};
  }

  async function refresh() {
    if (disposed) return;
    invalidate();
    const current = generation;
    controller = new AbortController();
    const options = { signal: controller.signal };
    state.loading = true;
    state.error = "";
    try {
      const courses = await request("/api/public/courses", options);
      if (disposed || current !== generation) return;
      const rows = await Promise.all(courses.map(async (course) => {
        try { return [course.id, await request(`/api/public/courses/${course.id}`, options)]; }
        catch (error) { if (error.status === 404) return [course.id, null]; throw error; }
      }));
      if (disposed || current !== generation) return;
      const details = Object.fromEntries(rows.filter(([, detail]) => detail));
      state.courses = courses.filter((course) => details[course.id]);
      state.details = details;
      state.overlays = Object.fromEntries(state.courses.filter((course) => state.overlays[course.id] === true).map((course) => [course.id, true]));
      if (!details[state.selectedId]) state.selectedId = state.courses[0]?.id ?? null;
    } catch (error) {
      if (disposed || current !== generation) return;
      state.courses = [];
      state.error = error.message || "공개 코스를 불러오지 못했습니다.";
    } finally {
      if (!disposed && current === generation) state.loading = false;
    }
  }

  async function exportCourse(id, buildArchive) {
    if (disposed || state.loading || !state.details[id]) throw new Error("공개 코스를 다시 불러온 뒤 다운로드하세요.");
    // The displayed snapshot stays unchanged until a manual refresh. Downloads
    // independently recheck publication, without refreshing the map on failure.
    const detail = await request(`/api/public/courses/${id}`);
    if (disposed) throw new Error("코스가 변경되었습니다. 다시 다운로드하세요.");
    const archive = await buildArchive(detail);
    const latest = await request(`/api/public/courses/${id}`);
    if (disposed || JSON.stringify(latest) !== JSON.stringify(detail)) {
      throw new Error("코스가 변경되었습니다. 다시 다운로드하세요.");
    }
    return archive;
  }

  function dispose() { disposed = true; invalidate(); }
  return { refresh, exportCourse, dispose };
}
