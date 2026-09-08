import { resolveCourseRoute } from "../../../lib/route-mode.mjs";
import { courseDirectionOptions } from "./course-display.mjs";

export function publicCourseGeometry({ course, cones, route }) {
  try {
    const { centerline } = resolveCourseRoute(cones, route.markers, route.steps, {
      step: 1.0, fallback: courseDirectionOptions(course, cones),
    });
    return { line: centerline.ok ? centerline : null };
  } catch { return { line: null }; }
}

if (typeof self !== "undefined") {
  self.onmessage = ({ data: details }) => {
    for (const [id, detail] of Object.entries(details)) {
      self.postMessage({ id, geometry: publicCourseGeometry(detail) });
    }
  };
}
