import type { Express } from "express";
import { config } from "../../config.js";
import { getProjectionLag, getResourceById, listReservations, listResources } from "../../projections/store.js";
import { paginationQuerySchema } from "../schemas.js";
import { requireAuth, type AuthedRequest } from "../security.js";
import { response, safe, send } from "../../application/pipeline.js";

export const registerQueryRoutes = (app: Express) => {
  app.get("/resources", requireAuth, (req, res) =>
    safe(
      Promise.resolve(paginationQuerySchema.safeParse(req.query))
        .then((parsed) => ({
          limit: parsed.success && parsed.data.limit ? parsed.data.limit : config.pageLimitDefault,
          nextCursor: parsed.success ? parsed.data.nextCursor : undefined
        }))
        .then(({ limit, nextCursor }) =>
          Promise.all([listResources(limit, nextCursor), getProjectionLag()])
        )
        .then(([resources, projectionLag]) =>
          response(200, {
            items: resources.items,
            nextCursor: resources.nextCursor,
            meta: { projectionLag }
          })
        )
    ).then(send(res))
  );

  app.get("/resources/:resourceId", requireAuth, (req, res) =>
    safe(
      Promise.all([getResourceById(req.params.resourceId), getProjectionLag()]).then(
        ([resource, projectionLag]) =>
          resource === null
            ? response(404, {
                error: {
                  code: "RESOURCE_NOT_FOUND",
                  reason: "Resource does not exist",
                  meta: { resourceId: req.params.resourceId }
                }
              })
            : response(200, {
                item: resource,
                meta: { projectionLag }
              })
      )
    ).then(send(res))
  );

  app.get("/reservations/active", requireAuth, (req, res) => {
    const auth = (req as AuthedRequest).auth;
    return safe(
      Promise.resolve(paginationQuerySchema.safeParse(req.query))
        .then((parsed) => ({
          scope: parsed.success && parsed.data.scope ? parsed.data.scope : "me",
          limit: parsed.success && parsed.data.limit ? parsed.data.limit : config.pageLimitDefault,
          nextCursor: parsed.success ? parsed.data.nextCursor : undefined
        }))
        .then(({ scope, limit, nextCursor }) =>
          Promise.all([
            listReservations({
              scope: auth.role === "admin" ? scope : "me",
              userId: auth.sub,
              status: "active",
              limit,
              nextCursor
            }),
            getProjectionLag()
          ])
        )
        .then(([page, projectionLag]) =>
          response(200, {
            items: page.items,
            nextCursor: page.nextCursor,
            meta: { projectionLag }
          })
        )
    ).then(send(res));
  });

  app.get("/reservations/history", requireAuth, (req, res) => {
    const auth = (req as AuthedRequest).auth;
    return safe(
      Promise.resolve(paginationQuerySchema.safeParse(req.query))
        .then((parsed) => ({
          scope: parsed.success && parsed.data.scope ? parsed.data.scope : "me",
          limit: parsed.success && parsed.data.limit ? parsed.data.limit : config.pageLimitDefault,
          nextCursor: parsed.success ? parsed.data.nextCursor : undefined
        }))
        .then(({ scope, limit, nextCursor }) =>
          Promise.all([
            listReservations({
              scope: auth.role === "admin" ? scope : "me",
              userId: auth.sub,
              limit,
              nextCursor
            }),
            getProjectionLag()
          ])
        )
        .then(([page, projectionLag]) =>
          response(200, {
            items: page.items,
            nextCursor: page.nextCursor,
            meta: { projectionLag }
          })
        )
    ).then(send(res));
  });
};
