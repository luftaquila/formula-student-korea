export function createEmailStore({ db }) {
  /* ============================================
   Config
   ============================================ */
  function getConfig(key) {
    return db.prepare("SELECT value FROM config WHERE key = ?").get(key)?.value || "";
  }

  function getAllConfig() {
    return db.prepare("SELECT key, value FROM config").all();
  }

  return { getConfig, getAllConfig };
}
