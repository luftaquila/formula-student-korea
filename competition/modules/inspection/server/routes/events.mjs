export function registerEventsRoutes({ app, sseHandler, revalidateSsePermission }) {
  // 클라이언트의 반응형 연결 해제와 별개로, 열린 스트림도 최신 권한을 주기적으로 재검증한다.
  app.get(
    "/api/sheet/events",
    sseHandler(null, {
      meta: (req) => ({
        email: req.user?.email,
        role: req.user?.role,
        permissions: req.user?.permissions || [],
      }),
      revalidate: revalidateSsePermission,
    }),
  );
}
