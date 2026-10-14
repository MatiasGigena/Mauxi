export function hasErrorCode(cause: unknown, ...codes: string[]): boolean {
  return cause instanceof Error && "code" in cause && codes.some((code) => code === cause.code);
}
