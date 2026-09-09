function normalizedCategoryName(value) {
  return String(value || "").trim().replace(/\s*검차\s*$/, "");
}

export function findInspectionCategory(categories, inspectionName, vehicleType) {
  const expectedName = normalizedCategoryName(inspectionName);
  if (!expectedName || !Array.isArray(categories)) return null;

  const matches = categories.filter((category) => {
    if (normalizedCategoryName(category?.name) !== expectedName) return false;
    const excludedTypes = Array.isArray(category?.excluded_types) ? category.excluded_types : [];
    return !excludedTypes.includes(vehicleType);
  });

  return matches.length === 1 ? matches[0] : null;
}
