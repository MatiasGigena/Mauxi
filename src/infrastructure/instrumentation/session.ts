import { parse } from "@babel/parser";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import type { IntegrationPlan } from "./plan";

export interface SessionPatch { path: string; before: string; after: string; }

const helper = `const fs = require('node:fs');
const path = require('node:path');
module.exports = original => async (phase, context) => {
  const config = await (typeof original === 'function' ? original(phase, context) : original);
  if (phase !== 'phase-development-server') return config;
  const root = path.resolve(__dirname, '..');
  const runtime = path.join(root, '.mauxi/runtime');
  const tsconfig = config?.typescript?.tsconfigPath || 'tsconfig.json';
  const source = path.resolve(root, tsconfig);
  if (!source.startsWith(root + path.sep)) throw new Error('Mauxi requires a TypeScript config within the app root');
  const temporary = path.join(runtime, 'tsconfig.json');
  if (!fs.existsSync(temporary)) {
    const settings = fs.existsSync(source) ? { extends: path.relative(runtime, source).split(path.sep).join("/") } : { compilerOptions: { allowJs: true, skipLibCheck: true, noEmit: true, jsx: 'preserve', module: 'esnext', moduleResolution: 'bundler' } };
    fs.writeFileSync(temporary, JSON.stringify(settings, null, 2), { flag: 'wx' });
  }
  const { writeAppTypeDeclarations } = require('next/dist/lib/typescript/writeAppTypeDeclarations');
  const typesPath = path.join(root, 'next-env.d.ts');
  if (fs.existsSync(typesPath)) fs.copyFileSync(typesPath, path.join(runtime, 'next-env.d.ts'));
  const expected = [];
  for (const distDir of ['.mauxi/runtime/next', '.mauxi/runtime/next/dev']) {
    await writeAppTypeDeclarations({ baseDir: runtime, distDir,
      imageImportsEnabled: !config?.images?.disableStaticImages,
      hasAppDir: fs.existsSync(path.join(root, 'app')) || fs.existsSync(path.join(root, 'src/app')),
      hasPagesDir: fs.existsSync(path.join(root, 'pages')) || fs.existsSync(path.join(root, 'src/pages')),
      strictRouteTypes: Boolean(config?.experimental?.strictRouteTypes), typedRoutes: Boolean(config?.typedRoutes)
    });
    expected.push(fs.readFileSync(path.join(runtime, 'next-env.d.ts'), 'utf8'));
  }
  fs.writeFileSync(path.join(runtime, 'expected-types.json'), JSON.stringify(expected));
  return { ...config, distDir: '.mauxi/runtime/next',
    allowedDevOrigins: [...new Set([...(config?.allowedDevOrigins || []), '127.0.0.1'])],
    typescript: { ...config?.typescript, tsconfigPath: '.mauxi/runtime/tsconfig.json' },
    agentRules: false
  };
};
`;

export const sessionLauncher = `const fs = require('node:fs');
const { spawn } = require('node:child_process');
const path = require('node:path');
const stat = fs.readFileSync('/proc/self/stat', 'utf8');
const start = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
fs.writeFileSync(path.join(__dirname, 'runtime/process.json'), JSON.stringify({ pid: process.pid, start }), { flag: 'wx' });
const child = spawn(process.argv[2], process.argv.slice(3), { stdio: 'inherit' });
child.on('error', error => { console.error(error.message); process.exit(1); });
child.on('exit', (code) => process.exit(code ?? 1));
`;

export async function addSessionIntegration(plan: IntegrationPlan): Promise<IntegrationPlan> {
  plan.runtimeDirectory = path.join(plan.workspaceRoot, ".mauxi/runtime");
  plan.createdFiles.push({ path: path.join(plan.workspaceRoot, ".mauxi/launcher.cjs"), content: sessionLauncher });
  if (plan.framework === "vite") {
    const cacheDirectory = JSON.stringify(path.join(plan.runtimeDirectory, "vite"));
    plan.patch = plan.patch!.replace('      apply: "serve",', () => `      apply: "serve",\n      config() { return { cacheDir: ${cacheDirectory} }; },`);
    return plan;
  }
  const names = ["next.config.ts", "next.config.mjs", "next.config.js"];
  const configs: string[] = [];
  for (const name of names) {
    try { await lstat(path.join(plan.workspaceRoot, name)); configs.push(name); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  if (configs.length > 1) throw new Error("Multiple Next configurations were found; choose one before importing.");
  plan.createdFiles.push({ path: path.join(plan.workspaceRoot, ".mauxi/next-session.cjs"), content: helper });
  if (!configs.length) {
    plan.createdFiles.push({ path: path.join(plan.workspaceRoot, "next.config.mjs"), content: 'import session from "./.mauxi/next-session.cjs";\nexport default session({});\n' });
    return plan;
  }
  const configPath = path.join(plan.workspaceRoot, configs[0]);
  const info = await lstat(configPath);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 524_288) throw new Error("Next configuration must be a bounded regular file.");
  const content = await readFile(configPath, "utf8");
  if (content.includes("__mauxiSession") || content.includes("mauxi-owned:")) throw new Error("Next configuration already contains Mauxi integration.");
  const ast = parse(content, { sourceType: "unambiguous", plugins: ["typescript"] });
  const exports = ast.program.body.flatMap(node => {
    if (node.type === "ExportDefaultDeclaration") return [{ expression: node.declaration, esm: true }];
    if (node.type === "ExpressionStatement" && node.expression.type === "AssignmentExpression") {
      const left = node.expression.left;
      if (left.type === "MemberExpression" && !left.computed && left.object.type === "Identifier" && left.object.name === "module" && left.property.type === "Identifier" && left.property.name === "exports") return [{ expression: node.expression.right, esm: false }];
    }
    return [];
  });
  if (exports.length !== 1) throw new Error("Next configuration needs one unambiguous default export or module.exports assignment.");
  const { expression, esm } = exports[0];
  const prefix = '/* mauxi-owned:session-open */__mauxiSession(';
  const suffix = ')/* mauxi-owned:session-close */';
  const declaration = '\n// mauxi-owned:start session-config\n// @ts-ignore -- temporary development adapter\n' + (esm
    ? 'import __mauxiSession from "./.mauxi/next-session.cjs";'
    : 'function __mauxiSession(value) { return require("./.mauxi/next-session.cjs")(value); }') + '\n// mauxi-owned:end session-config\n';
  const after = content.slice(0, expression.start!) + prefix + content.slice(expression.start!, expression.end!) + suffix + content.slice(expression.end!) + declaration;
  plan.sessionPatches = [{ path: configPath, before: content, after }];
  plan.sessionRemovals = [prefix, suffix, declaration];
  return plan;
}
