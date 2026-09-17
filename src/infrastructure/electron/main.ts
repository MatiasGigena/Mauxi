import { app, BrowserWindow, ipcMain, session, type Rectangle } from "electron";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let mainWindow: BrowserWindow | null = null;

if (!app.requestSingleInstanceLock()) app.quit();

app.on("second-instance", () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
});

function assertCaptureRect(value: unknown, bounds: Rectangle): asserts value is { previewId: string; x: number; y: number; width: number; height: number } {
  if (!value || typeof value !== "object") throw new Error("Invalid capture request");
  const input = value as Record<string, unknown>;
  if (!/^(desktop|mobile)$/.test(String(input.previewId))) throw new Error("Invalid preview ID");
  for (const key of ["x", "y", "width", "height"] as const) {
    if (typeof input[key] !== "number" || !Number.isFinite(input[key])) throw new Error(`Invalid ${key}`);
  }
  const x = Number(input.x);
  const y = Number(input.y);
  const width = Number(input.width);
  const height = Number(input.height);
  if (width < 1 || height < 1 || width > bounds.width || height > bounds.height) throw new Error("Capture dimensions exceed the shell");
  if (x < 0 || y < 0 || x + width > bounds.width + 1 || y + height > bounds.height + 1) throw new Error("Capture rectangle is outside the shell");
}

async function resolveFixtureSource(input: unknown) {
  if (!input || typeof input !== "object") throw new Error("Invalid source request");
  const value = input as Record<string, unknown>;
  if (value.fixture !== "vite" && value.fixture !== "next") throw new Error("Invalid fixture");
  if (typeof value.hint !== "string" || value.hint.length > 1_024) throw new Error("Invalid source hint");
  const root = path.resolve(process.cwd(), "fixtures", value.fixture);
  const basename = path.basename(value.hint);
  if (!/^[\w.-]+\.(tsx?|jsx?)$/.test(basename)) return null;
  const matches: string[] = [];
  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === ".next" || entry.name === "dist" || entry.name === ".mauxi") continue;
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(candidate);
      else if (entry.isFile() && entry.name === basename) matches.push(candidate);
    }
  }
  await walk(root);
  if (matches.length !== 1) return null;
  const content = await readFile(matches[0]);
  return {
    filePath: path.relative(root, matches[0]).split(path.sep).join("/"),
    fileFingerprint: createHash("sha256").update(content).digest("hex"),
  };
}

async function createWindow() {
  const window = new BrowserWindow({
    width: 1500,
    height: 1000,
    minWidth: 1024,
    minHeight: 700,
    backgroundColor: "#e9e8e5",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
    },
  });
  mainWindow = window;
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => {
    const rendererUrl = process.env.MAUXI_RENDERER_URL;
    if (rendererUrl && url.startsWith(rendererUrl)) return;
    if (!rendererUrl && url.startsWith("file:")) return;
    event.preventDefault();
  });
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  window.once("ready-to-show", () => window.show());
  if (process.env.MAUXI_RENDERER_URL) await window.loadURL(process.env.MAUXI_RENDERER_URL);
  else await window.loadFile(path.resolve(__dirname, "../renderer/index.html"));
}

ipcMain.handle("mauxi:resolve-fixture-source", async (event, input: unknown) => {
  if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) throw new Error("Untrusted source sender");
  return resolveFixtureSource(input);
});

ipcMain.handle("mauxi:capture-preview", async (event, input: unknown) => {
  if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) throw new Error("Untrusted capture sender");
  const bounds = mainWindow.getContentBounds();
  assertCaptureRect(input, bounds);
  const rect = {
    x: Math.floor(input.x),
    y: Math.floor(input.y),
    width: Math.ceil(input.width),
    height: Math.ceil(input.height),
  };
  const image = await mainWindow.webContents.capturePage(rect);
  const outputDirectory = process.env.MAUXI_EVIDENCE_DIR ?? path.resolve(process.cwd(), "evidence/captures");
  await mkdir(outputDirectory, { recursive: true });
  const outputPath = path.join(outputDirectory, `${input.previewId}-${Date.now()}.png`);
  const { writeFile } = await import("node:fs/promises");
  await writeFile(outputPath, image.toPNG());
  const size = image.getSize();
  return { path: outputPath, width: size.width, height: size.height };
});

app.whenReady().then(createWindow);
app.on("window-all-closed", () => app.quit());
