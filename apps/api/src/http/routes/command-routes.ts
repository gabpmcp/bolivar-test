import type { Express } from "express";
import { requireAuth, type AuthedRequest, signToken } from "../security.js";
import { resourceCommandEnvelopeSchema, userCommandEnvelopeSchema } from "../schemas.js";
import { response, runIdempotent, safe, send, validated } from "../../application/pipeline.js";
import { executeResourceCommand, executeUserCommand, type ResourceCommandInput, type UserCommandInput } from "../../application/command-dispatchers.js";

const requireIdempotencyKey = (value: string | undefined) => (value && value.length > 0 ? value : null);

export const registerCommandRoutes = (app: Express) => {
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
};
