import jwt from "jsonwebtoken";
import type { Request, Response, NextFunction } from "express";
import { config } from "../config.js";
import type { JwtClaims, Role } from "@app/shared";

export type AuthedRequest = Request & {
  auth: JwtClaims;
};

const denied = (res: Response, code: string, reason: string, meta: Record<string, unknown> = {}) =>
  res.status(401).json({
    error: { code, reason, meta }
  });

export const makeAuth = ({
  jwt,
  jwtSecret
}: {
  jwt: typeof import("jsonwebtoken");
  jwtSecret: string;
}) => {
  const signToken = (claims: JwtClaims) =>
    jwt.sign(claims, jwtSecret, {
      expiresIn: "8h"
    });

  const requireAuth = (req: Request, res: Response, next: NextFunction) =>
    (req.headers.authorization ?? "").startsWith("Bearer ")
      ? jwt.verify(
          (req.headers.authorization ?? "").replace(/^Bearer\s+/i, ""),
          jwtSecret,
          (error, decoded) =>
            error || !decoded
              ? denied(res, "UNAUTHORIZED", "Missing or invalid bearer token")
              : (((req as AuthedRequest).auth = decoded as JwtClaims), next())
        )
      : denied(res, "UNAUTHORIZED", "Missing or invalid bearer token");

  const requireRole =
    (...roles: Role[]) =>
    (req: Request, res: Response, next: NextFunction) =>
      roles.includes((req as AuthedRequest).auth.role)
        ? next()
        : res.status(403).json({
            error: {
              code: "FORBIDDEN",
              reason: "Role is not allowed for this action",
              meta: { requiredRoles: roles }
            }
          });

  return { signToken, requireAuth, requireRole };
};

export const { signToken, requireAuth, requireRole } = makeAuth({
  jwt,
  jwtSecret: config.jwtSecret
});
