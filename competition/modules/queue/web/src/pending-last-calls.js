export function addPendingKey(keys, key) {
  if (keys.has(key)) return keys;
  return new Set(keys).add(key);
}

export function removePendingKey(keys, key) {
  const next = new Set(keys);
  next.delete(key);
  return next;
}
