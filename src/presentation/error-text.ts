/** Electron wraps errors thrown by IPC handlers; people only need the handler's own message. */
export function errorText(cause: unknown): string {
  return (cause instanceof Error ? cause.message : String(cause)).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "");
}
