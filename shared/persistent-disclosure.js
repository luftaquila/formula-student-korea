export function readDisclosureState(storage, key, defaultOpen = true) {
  try {
    const value = storage?.getItem(key);
    if (value === "open") return true;
    if (value === "closed") return false;
  } catch {}
  return defaultOpen;
}

export function writeDisclosureState(storage, key, isOpen) {
  try {
    storage?.setItem(key, isOpen ? "open" : "closed");
  } catch {}
}
