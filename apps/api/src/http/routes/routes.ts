import type { Express } from "express";
import { config } from "../../config.js";
import { requireAuth, type AuthedRequest, signToken } from "../security.js";
import {
  paginationQuerySchema,
  resourceCommandEnvelopeSchema,
  userCommandEnvelopeSchema
} from "../schemas.js";
import { response, runIdempotent, safe, send, validated } from "../../application/pipeline.js";
import {
  executeResourceCommand,
  executeUserCommand,
  type ResourceCommandInput,
  type UserCommandInput
} from "../../application/command-dispatchers.js";
import {
  getProjectionLag,
  getResourceById,
  listReservations,
  listResources
} from "../../projections/store.js";

const requireIdempotencyKey = (value: string | undefined) => (value && value.length > 0 ? value : null);

export const registerRoutes = (app: Express) => {
  app.post("/commands/user", (req, res) =>
    safe(
      validated(userCommandEnvelopeSchema, req.body, "Invalid user command payload").then((parsed) => {
        if ("statusCode" in parsed) {
          return parsed;
        }
        const idempotencyKey = requireIdempotencyKey(req.header("Idempotency-Key") ?? undefined);
        return idempotencyKey === null
          ? response(400, {
              error: {
                code: "MISSING_IDEMPOTENCY_KEY",
                reason: "Idempotency-Key header is required",
                meta: {}
              }
            })
          : runIdempotent({
              idempotencyKey,
              content: { path: req.path, body: parsed },
              action: () =>
                executeUserCommand(parsed.command as UserCommandInput, {
                  actorBootstrapKey: req.header("x-admin-bootstrap-key") ?? "",
                  signToken
                })
            });
      })
    ).then(send(res))
  );

  app.post("/commands/resource", requireAuth, (req, res) => {
    const auth = (req as AuthedRequest).auth;
    return safe(
      validated(resourceCommandEnvelopeSchema, req.body, "Invalid resource command payload").then((parsed) => {
        if ("statusCode" in parsed) {
          return parsed;
        }
        const idempotencyKey = requireIdempotencyKey(req.header("Idempotency-Key") ?? undefined);
        return idempotencyKey === null
          ? response(400, {
              error: {
                code: "MISSING_IDEMPOTENCY_KEY",
                reason: "Idempotency-Key header is required",
                meta: {}
              }
            })
          : runIdempotent({
              idempotencyKey,
              content: { path: req.path, body: parsed, actor: auth.sub },
              action: () => executeResourceCommand(parsed.command as ResourceCommandInput, auth)
            });
      })
    ).then(send(res));
  });

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

