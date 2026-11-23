import { COURSE_ROUTES } from "fsk-coursekeeper/service/routes.mjs";
import { actorLabel } from "../respond.mjs";

// HTTP surface of the shared course service. Permissions are enforced by the
// course access roleFn before these handlers run.
export function registerCourseDataRoutes({ app, service, respond, publication }) {
  const courseValues = { course: publication.decorateCourse, courses: publication.decorateCourses };
  for (const route of COURSE_ROUTES) {
    app[route.method.toLowerCase()](route.path, (req, res) =>
      respond(req, res, {
        action: route.action,
        read: route.read,
        logRejections: route.logRejections,
        value: courseValues[route.courseValue],
      }, () => route.run(service, req.params, req.body ?? {}, { actor: actorLabel(req) })));
  }
}
