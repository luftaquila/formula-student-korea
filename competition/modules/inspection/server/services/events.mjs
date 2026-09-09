import { createSSEManager } from "../../../../../shared/server/sse.mjs";
import { authorizePrincipal, access } from "../../../../../shared/common/access-control.js";

export function createInspectionEvents({ logger, options, app }) {
  // 특정 연도나 문항을 기준으로 템플릿 내용을 시작 시 삽입·수정하지 않는다.
  // 업무 템플릿은 관리 API 또는 명시적인 JSON 가져오기를 통해서만 변경한다.

  /* ============================================
   SSE (Server-Sent Events) 설정
   ============================================ */
  const {
    broadcast: broadcastSSEEvent,
    handler: sseHandler,
    close: closeSse,
    revalidate: revalidateSse,
  } = createSSEManager(200, { logger });

  function broadcastEvent(event, data) {
    broadcastSSEEvent(event, data);
    options.onEvent?.(event, data);
  }

  async function revalidateSsePermission(meta) {
    if (!meta.email) return null;
    let result;
    try {
      result = await app.validateUser(meta.email, meta);
    } catch (error) {
      logger.warn(
        null,
        "sse.revalidate",
        {
          reason: "auth_error",
          error: error?.message || String(error),
        },
        meta.email,
        meta,
      );
      return null;
    }
    if (!result?.valid) {
      logger.warn(
        null,
        "sse.revalidate",
        {
          reason: result?.transient ? "auth_unavailable" : "invalid_user",
        },
        meta.email,
        meta,
      );
      return null;
    }

    const role = result.role ?? meta.role;
    const permissions = Array.isArray(result.permissions)
      ? result.permissions
      : meta.permissions || [];
    const principal = { kind: "human", role, permissions };
    if (!authorizePrincipal(principal, access.permission("inspection.operate"))) {
      logger.warn(
        null,
        "sse.revalidate",
        {
          reason: "permission_revoked",
          permission: "inspection.operate",
        },
        meta.email,
        { ...meta, role },
      );
      return null;
    }
    return { ...meta, role, permissions };
  }

  return {
    broadcastSSEEvent,
    sseHandler,
    closeSse,
    revalidateSse,
    broadcastEvent,
    revalidateSsePermission,
  };
}
