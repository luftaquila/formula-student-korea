// Keep selection framing separate from overlay and centerline redraws.
export function createPublicCourseViewport(map, getSelection) {
  let centeredId = null;
  const observer = new ResizeObserver(() => fit(true));
  observer.observe(map.getContainer());
  function fit(force = false) {
    const { id, cones } = getSelection();
    if (!cones?.length || (!force && centeredId === id)) return;
    // Leaflet caches size; flex layout changes do not emit window resize.
    map.invalidateSize({ pan: false });
    map.fitBounds(cones.map((cone) => [cone.lat, cone.lng]), { padding: [28, 28], maxZoom: 20, animate: false });
    centeredId = id;
  }
  return {
    fit,
    dispose() { observer.disconnect(); },
  };
}
