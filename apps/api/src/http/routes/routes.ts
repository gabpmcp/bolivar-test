import type { Express } from "express";
import { config } from "../../config.js";
import { requireAuth, type AuthedRequest, signToken } from "../security.js";
import {
  paginationQuerySchema,
  resourceCommandRequestSchema,
  userCommandRequestSchema
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

export const makeRegisterRoutes =
  (deps: {
    config: typeof config;
    requireAuth: typeof requireAuth;
    signToken: typeof signToken;
    paginationQuerySchema: typeof paginationQuerySchema;
    userCommandRequestSchema: typeof userCommandRequestSchema;
    resourceCommandRequestSchema: typeof resourceCommandRequestSchema;
    response: typeof response;
    runIdempotent: typeof runIdempotent;
    safe: typeof safe;
    send: typeof send;
    validated: typeof validated;
    executeUserCommand: typeof executeUserCommand;
    executeResourceCommand: typeof executeResourceCommand;
    listResources: typeof listResources;
    getProjectionLag: typeof getProjectionLag;
    getResourceById: typeof getResourceById;
    listReservations: typeof listReservations;
  }) =>
  (app: Express) => {
  app.post("/commands/user", (req, res) =>
    deps.safe(
      deps.validated(deps.userCommandRequestSchema, req.body, "Invalid user command payload").then((parsed) => {
        if ("statusCode" in parsed) {
          return parsed;
        }
        const idempotencyKey = requireIdempotencyKey(req.header("Idempotency-Key") ?? undefined);
        return idempotencyKey === null
          ? deps.response(400, {
              error: {
                code: "MISSING_IDEMPOTENCY_KEY",
                reason: "Idempotency-Key header is required",
                meta: {}
              }
            })
          : deps.runIdempotent({
              idempotencyKey,
              content: { path: req.path, body: parsed },
              action: () =>
                deps.executeUserCommand(parsed.command as UserCommandInput, {
                  actorBootstrapKey: req.header("x-admin-bootstrap-key") ?? "",
                  signToken: deps.signToken
                })
            });
      })
    ).then(deps.send(res))
  );

  app.post("/commands/resource", deps.requireAuth, (req, res) => {
    const auth = (req as AuthedRequest).auth;
    return deps.safe(
      deps.validated(deps.resourceCommandRequestSchema, req.body, "Invalid resource command payload").then((parsed) => {
        if ("statusCode" in parsed) {
          return parsed;
        }
        const idempotencyKey = requireIdempotencyKey(req.header("Idempotency-Key") ?? undefined);
        return idempotencyKey === null
          ? deps.response(400, {
              error: {
                code: "MISSING_IDEMPOTENCY_KEY",
                reason: "Idempotency-Key header is required",
                meta: {}
              }
            })
          : deps.runIdempotent({
              idempotencyKey,
              content: { path: req.path, body: parsed, actor: auth.sub },
              action: () => deps.executeResourceCommand(parsed.command as ResourceCommandInput, auth)
            });
      })
    ).then(deps.send(res));
  });

  app.get("/resources", deps.requireAuth, (req, res) =>
    deps.safe(
      Promise.resolve(deps.paginationQuerySchema.safeParse(req.query))
        .then((parsed) => ({
          limit: parsed.success && parsed.data.limit ? parsed.data.limit : deps.config.pageLimitDefault,
          nextCursor: parsed.success ? parsed.data.nextCursor : undefined
        }))
        .then(({ limit, nextCursor }) =>
          Promise.all([deps.listResources(limit, nextCursor), deps.getProjectionLag()])
        )
        .then(([resources, projectionLag]) =>
          deps.response(200, {
            items: resources.items,
            nextCursor: resources.nextCursor,
            meta: { projectionLag }
          })
        )
    ).then(deps.send(res))
  );

  app.get("/resources/:resourceId", deps.requireAuth, (req, res) =>
    deps.safe(
      Promise.all([deps.getResourceById(req.params.resourceId), deps.getProjectionLag()]).then(
        ([resource, projectionLag]) =>
          resource === null
            ? deps.response(404, {
                error: {
                  code: "RESOURCE_NOT_FOUND",
                  reason: "Resource does not exist",
                  meta: { resourceId: req.params.resourceId }
                }
              })
            : deps.response(200, {
                item: resource,
                meta: { projectionLag }
              })
      )
    ).then(deps.send(res))
  );

  app.get("/reservations/active", deps.requireAuth, (req, res) => {
    const auth = (req as AuthedRequest).auth;
    return deps.safe(
      Promise.resolve(deps.paginationQuerySchema.safeParse(req.query))
        .then((parsed) => ({
          scope: parsed.success && parsed.data.scope ? parsed.data.scope : "me",
          limit: parsed.success && parsed.data.limit ? parsed.data.limit : deps.config.pageLimitDefault,
          nextCursor: parsed.success ? parsed.data.nextCursor : undefined
        }))
        .then(({ scope, limit, nextCursor }) =>
          Promise.all([
            deps.listReservations({
              scope: auth.role === "admin" ? scope : "me",
              userId: auth.sub,
              status: "active",
              limit,
              nextCursor
            }),
            deps.getProjectionLag()
          ])
        )
        .then(([page, projectionLag]) =>
          deps.response(200, {
            items: page.items,
            nextCursor: page.nextCursor,
            meta: { projectionLag }
          })
        )
    ).then(deps.send(res));
  });

  app.get("/reservations/history", deps.requireAuth, (req, res) => {
    const auth = (req as AuthedRequest).auth;
    return deps.safe(
      Promise.resolve(deps.paginationQuerySchema.safeParse(req.query))
        .then((parsed) => ({
          scope: parsed.success && parsed.data.scope ? parsed.data.scope : "me",
          limit: parsed.success && parsed.data.limit ? parsed.data.limit : deps.config.pageLimitDefault,
          nextCursor: parsed.success ? parsed.data.nextCursor : undefined
        }))
        .then(({ scope, limit, nextCursor }) =>
          Promise.all([
            deps.listReservations({
              scope: auth.role === "admin" ? scope : "me",
              userId: auth.sub,
              limit,
              nextCursor
            }),
            deps.getProjectionLag()
          ])
        )
        .then(([page, projectionLag]) =>
          deps.response(200, {
            items: page.items,
            nextCursor: page.nextCursor,
            meta: { projectionLag }
          })
        )
    ).then(deps.send(res));
  });
};

export const registerRoutes = makeRegisterRoutes({
  config,
  requireAuth,
  signToken,
  paginationQuerySchema,
  userCommandRequestSchema,
  resourceCommandRequestSchema,
  response,
  runIdempotent,
  safe,
  send,
  validated,
  executeUserCommand,
  executeResourceCommand,
  listResources,
  getProjectionLag,
  getResourceById,
  listReservations
});

