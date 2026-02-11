import type { DomainError } from "./types.js";

export const domainError = (
  code: string,
  reason: string,
  meta: Record<string, unknown> = {}
): DomainError => ({
  error: { code, reason, meta }
});
