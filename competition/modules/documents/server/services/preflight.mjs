export function createDocumentPreflight({ dbRun, logger }) {
  function auditedLookup(req, res, { action, target, phase, lookup, message }) {
    const result = dbRun(lookup);
    if (!result.success) {
      const error = result.internalError || result.error;
      logger.warn(req, action, { error, reason: error, phase }, target);
      res.status(500).send(message);
      return { ok: false, value: null };
    }
    return { ok: true, value: result.result };
  }

  return { auditedLookup };
}
