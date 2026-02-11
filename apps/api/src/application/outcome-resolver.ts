export const resolveOutcome = <
  T extends { kind: string },
  K extends T["kind"],
  R
>(
  value: T,
  successKind: K,
  onSuccess: (matched: Extract<T, { kind: K }>) => R,
  onFailure: (other: Exclude<T, { kind: K }>) => R
): R =>
  value.kind === successKind
    ? onSuccess(value as Extract<T, { kind: K }>)
    : onFailure(value as Exclude<T, { kind: K }>);
