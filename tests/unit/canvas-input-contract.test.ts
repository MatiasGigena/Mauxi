import { describe, expect, it } from "vitest";
import { BRIDGE_PROTOCOL, isBridgeMessage, isShellMessage } from "../../src/application/preview-contract";

const envelope = { protocol: BRIDGE_PROTOCOL, session: "session", generation: "document" };
const zoom = { ...envelope, kind: "canvas-zoom", deltaY: -30, deltaMode: 0, clientX: 200, clientY: 100 };

describe("canvas input bridge contract", () => {
  it.each(["exit", "space", "space-end"])("accepts the %s shortcut", action => {
    expect(isBridgeMessage({ ...envelope, kind: "canvas-shortcut", action })).toBe(true);
  });
  it("rejects unknown actions and invalid envelopes", () => {
    expect(isBridgeMessage({ ...envelope, kind: "canvas-shortcut", action: "click" })).toBe(false);
    expect(isBridgeMessage({ ...zoom, session: null })).toBe(false);
    expect(isBridgeMessage({ ...zoom, generation: {} })).toBe(false);
  });
  it.each([0, 1, 2])("accepts bounded zoom data in delta mode %d", deltaMode => {
    expect(isBridgeMessage({ ...zoom, deltaMode })).toBe(true);
  });
  it.each([
    { deltaMode: "0" }, { deltaMode: 3 }, { deltaMode: Symbol("invalid") },
    { deltaY: NaN }, { deltaY: Infinity }, { deltaY: 100_001 },
    { clientX: -1 }, { clientX: 10_001 }, { clientY: undefined },
  ])("rejects malformed zoom data: %s", value => {
    expect(isBridgeMessage({ ...zoom, ...value })).toBe(false);
  });
  it("requires an explicit boolean for shell-controlled shortcuts", () => {
    expect(isShellMessage({ ...envelope, kind: "canvas-controls", enabled: true })).toBe(true);
    expect(isShellMessage({ ...envelope, kind: "canvas-controls", enabled: false })).toBe(true);
    expect(isShellMessage({ ...envelope, kind: "canvas-controls", enabled: "yes" })).toBe(false);
  });
});
