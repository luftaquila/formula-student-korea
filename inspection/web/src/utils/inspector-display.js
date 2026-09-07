const PREVIEW_LIMIT = 2;

export function inspectorDisplay(inspectors) {
  const names = Array.isArray(inspectors) ? [...inspectors] : [];
  return {
    names,
    preview: names.slice(0, PREVIEW_LIMIT).join(" "),
    remaining: Math.max(0, names.length - PREVIEW_LIMIT),
    expandable: names.length > PREVIEW_LIMIT,
  };
}
