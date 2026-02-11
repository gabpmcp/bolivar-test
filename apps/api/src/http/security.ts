import jwt from "jsonwebtoken";
import type { Request, Response, NextFunction } from "express";
import { config } from "../config.js";
import type { Role } from "../domain/types.js";

type JwtClaims = {
  sub: string;
  role: Role;
  email: string;
};

export const signToken = (claims: JwtClaims) =>
  jwt.sign(claims, config.jwtSecret, {
    expiresIn: "8h"
  });

export type AuthedRequest = Request & {
  auth: JwtClaims;
};

const denied = (res: Response, code: string, reason: string, meta: Record<string, unknown> = {}) =>
  res.status(401).json({
    error: { code, reason, meta }
  });

export const requireAuth = (req: Request, res: Response, next: NextFunction) =>
  (req.headers.authorization ?? "").startsWith("Bearer ")
    ? jwt.verify(
        (req.headers.authorization ?? "").replace(/^Bearer\s+/i, ""),
        config.jwtSecret,
        (error, decoded) =>
          error || !decoded
            ? denied(res, "UNAUTHORIZED", "Missing or invalid bearer token")
            : (((req as AuthedRequest).auth = decoded as JwtClaims), next())
      )
    : denied(res, "UNAUTHORIZED", "Missing or invalid bearer token");

export const requireRole =
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
