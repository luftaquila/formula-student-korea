import { parseCompetitionYear } from "../../../../../shared/common/competition-year.mjs";

export function registerVehicleTypesRoutes({
  app,
  store,
  logger,
  sendError,
  auditVehicleType,
  notifyChange,
}) {
  app.get("/vehicle-types", (req, res) => {
    try {
      res.json(store.listVehicleTypes(parseCompetitionYear(req.query.year)));
    } catch (error) {
      logger.warn(
        req,
        "vehicle_type.list",
        {
          requestedYear: req.query.year ?? null,
          error: error.message,
        },
        req.query.year == null ? undefined : String(req.query.year),
      );
      sendError(res, error);
    }
  });

  app.post("/vehicle-types", (req, res) => {
    let year;
    try {
      year = parseCompetitionYear(req.query.year);
      const type = store.createVehicleType(year, req.body);
      logger.log(
        req,
        "vehicle_type.create",
        { vehicleType: auditVehicleType(type) },
        String(type.id),
      );
      notifyChange(req, { year: type.year }, String(type.id));
      res.status(201).json(type);
    } catch (error) {
      logger.warn(req, "vehicle_type.create", { year, requested: req.body, error: error.message });
      sendError(res, error);
    }
  });

  app.patch("/vehicle-types/:id", (req, res) => {
    let before = null;
    try {
      before = store.getVehicleType(req.params.id);
      const result = store.updateVehicleType(req.params.id, req.body);
      logger.log(
        req,
        "vehicle_type.update",
        {
          before: auditVehicleType(result.before),
          after: auditVehicleType(result.after),
          updatedProjections: result.projections,
        },
        String(result.after.id),
      );
      notifyChange(req, { year: result.after.year }, String(result.after.id));
      res.json(result.after);
    } catch (error) {
      logger.warn(
        req,
        "vehicle_type.update",
        {
          id: req.params.id,
          before: auditVehicleType(before),
          requested: req.body,
          error: error.message,
        },
        String(req.params.id),
      );
      sendError(res, error);
    }
  });

  app.delete("/vehicle-types/:id", (req, res) => {
    try {
      const type = store.deleteVehicleType(req.params.id);
      logger.log(
        req,
        "vehicle_type.delete",
        { vehicleType: auditVehicleType(type) },
        String(type.id),
      );
      notifyChange(req, { year: type.year }, String(type.id));
      res.status(204).send();
    } catch (error) {
      logger.warn(req, "vehicle_type.delete", { id: req.params.id, error: error.message });
      sendError(res, error);
    }
  });
}
