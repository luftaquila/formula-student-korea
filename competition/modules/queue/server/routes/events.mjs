export function registerEventsRoutes({ app, sseHandler, getActiveInspections, db }) {
  // SSE 엔드포인트
  app.get(
    "/api/events",
    sseHandler(
      () => {
        const activeInspections = getActiveInspections();
        const allBooths = {};
        for (const row of db
          .prepare(
            `
    SELECT inspection, booth_num, active, occupied_by, entered_at, timer_paused_at, timer_paused_ms
    FROM booth ORDER BY inspection, booth_num
  `,
          )
          .all()) {
          (allBooths[row.inspection] ||= []).push(row);
        }
        return { activeInspections, allBooths };
        // 공개 SSE라 비인증 단일 IP가 전역 상한(200)을 독점해 전광판·키오스크 갱신을 막는 DoS를
        // 완화하기 위한 per-IP 동시연결 상한. 대회장은 하나의 NAT 공인 IP를 공유할 수 있어(전광판+
        // 키오스크+스태프) 넉넉히 20으로 둔다 — 단일 IP가 전역의 10%까지만 점유. 필요 시 상향 튜닝.
      },
      { maxPerIp: 20 },
    ),
  );
}
