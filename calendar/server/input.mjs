export function canonicalAudience(role) {
  if (role === "public" || role === "student") return role;
  return "official";
}
