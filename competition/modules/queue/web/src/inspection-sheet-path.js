export function inspectionSheetPath({ base = "", year, num, categoryId }) {
  const path = `${base}/${year}/${num}`;
  if (categoryId === undefined || categoryId === null || categoryId === "") return path;
  return `${path}?category=${encodeURIComponent(categoryId)}`;
}
