// Shared rendering contract for the operator and public maps.
export function courseDisplayState(courseId, selectedId, overlays = {}) {
  if (courseId === selectedId) return "selected";
  return overlays[courseId] === true ? "overlay" : "hidden";
}

export function courseDirectionOptions(course, cones) {
  const start = course.start_cone_id != null ? cones.find((cone) => cone.id === course.start_cone_id) : null;
  return {
    ...(start ? { start: { lat: start.lat, lng: start.lng } } : {}),
    ...(course.reverse ? { reverse: true } : {}),
  };
}
