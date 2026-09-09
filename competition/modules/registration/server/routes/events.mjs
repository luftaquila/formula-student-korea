export function registerEventsRoutes({ app, parseEventYear, sseHandler, publicStatus }) {
  app.get(
    "/api/events",
    parseEventYear,
    sseHandler((req) => publicStatus(req.registrationYear), {
      meta: (req) => ({ year: req.registrationYear }),
      maxPerIp: 20,
    }),
  );
}
