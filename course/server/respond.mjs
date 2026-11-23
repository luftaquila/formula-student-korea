import { resultResponse } from "fsk-coursekeeper/service/routes.mjs";

// Turns course service results into HTTP responses, audit logs, and SSE
// broadcasts. `decorate` lets FSK-only state (publication) ride along on course
// payloads without the shared service knowing about it.
export function createServiceResponder({ logger, broadcast, decorate = (_event, payload) => payload }) {
  // options.read: reads log only unexpected failures, unless logRejections is set.
  // options.value: maps a successful response value before it is sent.
  return function respond(req, res, { action, read = false, logRejections = !read, value = (v) => v }, run) {
    let result;
    try {
      result = run();
    } catch (error) {
      logger.warn(req, action, { error: error?.message || String(error) }, error?.subject ?? null);
      return res.status(500).send("Server error.");
    }

    if (!result.ok && (logRejections || result.status >= 500)) {
      logger.warn(req, action, { error: result.error, ...result.detail }, result.subject);
    }
    if (result.ok) {
      if (result.audited) logger.log(req, action, result.detail, result.subject);
      for (const warning of result.warnings) logger.warn(req, action, warning, result.subject);
      for (const [event, payload] of result.events) broadcast(event, decorate(event, payload));
      if (result.value !== undefined) result = { ...result, value: value(result.value) };
    }

    const response = resultResponse(result);
    for (const [name, header] of Object.entries(response.headers || {})) res.setHeader(name, header);
    if (response.json !== undefined) return res.status(response.status).json(response.json);
    if (response.status === 204) return res.status(204).end();
    return res.status(response.status).send(response.text);
  };
}

export function actorLabel(req) {
  return req.user ? `${req.user.name || ""} <${req.user.email || ""}>` : null;
}
