import { expect, test, type Page } from "@playwright/test";
import type { AgentDialogResponse } from "../../src/application/agent-contract";
import { mockDesktop } from "./fixtures";


type PermissionDialogTest = { responses: AgentDialogResponse[]; fail: boolean; pending: boolean; releaseResponse?: () => void };

declare global {
  interface Window { permissionDialogTest?: PermissionDialogTest }
}

function setupTest(page: Page) {
  return page.evaluateHandle(() => {
    if (!window.setupTest) throw new Error("mockDesktop did not install setupTest");

    return window.setupTest;
  });
}

const operation = JSON.stringify({ executable: "mkdir", args: ["-p", "src/app/header-variants"], cwd: "/projects/rondo", purpose: "Create an isolated route for the header variants." }, null, 2);
const warnings = ["Commands may change caches, databases, remote APIs, or activity outside checkpoint coverage.", "Approval applies only to this exact executable, arguments, and working directory.", "Commands and dependency installs can execute project code."];

async function openWorkspace(page: Page) {
  await mockDesktop(page);
  await page.getByRole("button", { name: "Confirm & start", exact: true }).click();
  await page.evaluate(() => {
    const state: PermissionDialogTest = { responses: [], fail: false, pending: false };
    window.permissionDialogTest = state;
    window.mauxi!.agentDialogResponse = async response => {
      state.responses.push(response);

      if (state.fail) throw new Error("Permission response could not be delivered.");

      if (state.pending) await new Promise<void>(resolve => { state.releaseResponse = resolve; });
    };
  });
}

async function requestApproval(page: Page, title = "Approve command", exactOperation = operation) {
  await (await setupTest(page)).evaluate((state, { title, operation, warnings }) => {
    state.agentListeners.forEach(listener => listener({ type: "dialog", dialog: { id: "permission-fixture", kind: "approval", title, message: "Create the directory for three header variants.", operation, cwd: "/projects/rondo", warnings } }));
  }, { title, operation: exactOperation, warnings });

  return page.getByRole("dialog", { name: title, exact: true });
}

for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 800 }, { width: 320, height: 480 }]) {
  test(`permissions share the Desktop actions theme at ${viewport.width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    await openWorkspace(page);
    await page.getByRole("button", { name: "Desktop actions", exact: true }).click();
    const actions = page.getByRole("dialog", { name: "Desktop actions", exact: true });

    const theme = await actions.evaluate(node => {
      const s = getComputedStyle(node);
      const h = getComputedStyle(node.querySelector("h2")!);

      return [s.backgroundColor, s.borderColor, s.borderRadius, s.padding, s.boxShadow, s.fontFamily, h.fontSize, h.fontWeight];
    });

    await actions.getByRole("button", { name: "Close actions" }).click();
    const dialog = await requestApproval(page, "Approve command", operation + "\n" + "long-path-".repeat(50));
    expect(await dialog.evaluate(node => {
      const s = getComputedStyle(node);
      const h = getComputedStyle(node.querySelector("h2")!);

      return [s.backgroundColor, s.borderColor, s.borderRadius, s.padding, s.boxShadow, s.fontFamily, h.fontSize, h.fontWeight];
    })).toEqual(theme);
    await expect(dialog).toHaveAttribute("aria-modal", "true");
    await expect(dialog.locator("pre")).toHaveText(operation + "\n" + "long-path-".repeat(50));
    await expect(dialog.locator(".approval-warnings li")).toHaveText(warnings);
    await expect(dialog.locator(".approval-warnings svg[aria-hidden=true]")).toHaveCount(3);
    await expect(dialog.getByRole("button", { name: "Deny", exact: true })).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    const approve = dialog.getByRole("button", { name: "Approve once" });
    await expect(approve).toHaveCSS("background-color", "rgb(24, 27, 34)");
    await expect(approve.locator("svg.lucide-arrow-up-right")).toHaveCount(1);
    expect(await dialog.evaluate(node => {
      const rect = node.getBoundingClientRect();

      return { overflow: node.scrollWidth > node.clientWidth, contained: rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight };
    })).toEqual({ overflow: false, contained: true });
    await page.screenshot({ path: testInfo.outputPath("permission-dialog.png") });
  });
}

for (const action of ["Deny", "Deny and close", "Escape"]) {
  test(`${action} denies exactly once and restores focus`, async ({ page }) => {
    await openWorkspace(page);
    const opener = page.getByRole("button", { name: "Desktop actions", exact: true });
    await opener.focus();
    const dialog = await requestApproval(page);
    const close = dialog.getByRole("button", { name: "Deny and close" });
    await expect(close).toBeFocused();
    await close.press("Shift+Tab");
    await expect(dialog.getByRole("button", { name: "Approve once" })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(close).toBeFocused();
    await expect(close).toHaveCSS("outline-color", "rgb(33, 143, 144)");

    if (action === "Escape") await page.keyboard.press("Escape");
    else await dialog.getByRole("button", { name: action, exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(opener).toBeFocused();
    expect(await page.evaluate(() => window.permissionDialogTest!.responses)).toEqual([{ workspaceId: "test-workspace", dialogId: "permission-fixture", cancelled: true }]);
  });
}

test("approval remains explicit, pending responses cannot be duplicated, and reduced motion is respected", async ({ page }) => {
  await openWorkspace(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.evaluate(() => { window.permissionDialogTest!.pending = true; });
  const dialog = await requestApproval(page);
  const approve = dialog.getByRole("button", { name: "Approve once" });
  await approve.hover();
  await expect(approve).toHaveCSS("transform", "none");
  expect(await approve.evaluate(node => getComputedStyle(node, "::before").animationName)).toBe("none");
  await approve.click();
  await expect(dialog.getByRole("button", { name: "Deny and close" })).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "Deny", exact: true })).toBeDisabled();
  await expect(approve).toBeDisabled();
  await dialog.press("Escape");
  expect(await page.evaluate(() => window.permissionDialogTest!.responses)).toEqual([{ workspaceId: "test-workspace", dialogId: "permission-fixture", value: "approve", cancelled: false }]);
  await page.evaluate(() => window.permissionDialogTest!.releaseResponse!());
  await expect(dialog).toHaveCount(0);
});

test("delivery errors keep the permission request open and allow denial", async ({ page }) => {
  await openWorkspace(page);
  await page.evaluate(() => { window.permissionDialogTest!.fail = true; });
  const dialog = await requestApproval(page);
  await dialog.getByRole("button", { name: "Approve once" }).click();
  await expect(dialog.getByRole("alert")).toHaveText("Permission response could not be delivered.");
  await expect(dialog.getByRole("button", { name: "Deny and close" })).toBeEnabled();
  await page.evaluate(() => { window.permissionDialogTest!.fail = false; });
  await dialog.getByRole("button", { name: "Deny", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(await page.evaluate(() => window.permissionDialogTest!.responses.at(-1)!.cancelled)).toBe(true);
});

test("browser approvals keep their nonblocking preview access while sharing the surface", async ({ page }) => {
  await openWorkspace(page);
  const dialog = await requestApproval(page, "Approve browser action");
  await expect(dialog).toHaveAttribute("aria-modal", "false");
  await expect(dialog).toHaveCSS("border-radius", "20px");
  await expect(dialog).toHaveCSS("background-color", "rgb(255, 255, 255)");
  await expect(page.locator(".browser-approval")).toHaveCSS("pointer-events", "none");
  await expect(dialog).toHaveCSS("pointer-events", "auto");
  await page.getByRole("button", { name: "Desktop actions", exact: true }).click();
  const actions = page.getByRole("dialog", { name: "Desktop actions", exact: true });
  await expect(actions).toBeVisible();
  await actions.getByRole("button", { name: "Close actions" }).click();
  await dialog.getByRole("button", { name: "Deny", exact: true }).click();
  await expect(dialog).toHaveCount(0);
});
