import { z } from "zod";
import { match } from "ts-pattern";
import type { Response } from "express";
import type { DomainError } from "../domain/types.js";
import { idempotencyDecision, loadIdempotency, saveIdempotency } from "../infra/idempotency.js";

export type HttpResponse = { statusCode: number; body: unknown };

export const response = (statusCode: number, body: unknown): HttpResponse => ({ statusCode, body });

export const send = (res: Response) => ({ statusCode, body }: HttpResponse) =>
  res.status(statusCode).json(body);

export const nowUtc = () => new Date().toISOString();

export const statusOf = ({ error: { code } }: DomainError) =>
  match(code)
    .with("FORBIDDEN", "UNAUTHORIZED_CANCEL", "BOOTSTRAP_FORBIDDEN", () => 403)
    .with("RESOURCE_NOT_FOUND", "RESERVATION_NOT_FOUND", "USER_NOT_FOUND", () => 404)
    .with(
      "RESOURCE_NAME_TAKEN",
      "RESOURCE_ALREADY_EXISTS",
      "USER_ALREADY_EXISTS",
      "RESERVATION_OVERLAP",
      "VERSION_CONFLICT",
      "IDEMPOTENCY_HASH_MISMATCH",
      () => 409
    )
    .with("INVALID_CREDENTIALS", () => 401)
    .with("INVALID_INTERVAL", "RESERVATION_IN_PAST", () => 400)
    .otherwise(() => 400);

export const domainErrorResponse = (error: DomainError) => response(statusOf(error), error);

export const badRequest = (reason: string, meta: Record<string, unknown> = {}) => ({
  error: {
    code: "INVALID_REQUEST",
    reason,
    meta
  }
});

export const internalError = (error: unknown) =>
  response(500, {
    error: {
      code: "INTERNAL_ERROR",
      reason: "Unhandled server error",
      meta: {
        message: error instanceof Error ? error.message : String(error)
      }
    }
  });

export const safe = (promise: Promise<HttpResponse>) => promise.catch(internalError);

export const validated = <T>(
  schema: z.ZodType<T>,
  payload: unknown,
  reason: string
): Promise<T | HttpResponse> =>
  Promise.resolve(schema.safeParse(payload)).then((parsed) =>
    parsed.success ? parsed.data : response(400, badRequest(reason, parsed.error.flatten()))
  );

export const runIdempotent = ({
  idempotencyKey,
  content,
  action
}: {
  idempotencyKey: string;
  content: unknown;
  action: () => Promise<HttpResponse>;
}) =>
  loadIdempotency(idempotencyKey).then((existing) =>
    match(idempotencyDecision(existing, idempotencyKey, content))
      .with({ kind: "replay" }, ({ record }) => response(record.statusCode, record.responseBody))
      .with({ kind: "mismatch" }, ({ error }) => domainErrorResponse(error))
      .with({ kind: "new" }, ({ contentHash }) =>
        action().then((result) =>
          saveIdempotency({
            idempotencyKey,
            contentHash,
            statusCode: result.statusCode,
            responseBody: result.body,
            createdAtUtc: nowUtc()
          })
            .then(() => result)
            .catch(() => result)
        )
      )
      .exhaustive()
  );
