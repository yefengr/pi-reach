import { cp, lstat, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const PACKAGE = "@pi-reach/protocol";
const ENTRIES = new Set(["outer", "session"]);

export function resolveVendorProtocolPaths(scriptFile = fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(scriptFile), "../..");
  return { extensionDist: resolve(root, "pi-extension/dist"), protocolDist: resolve(root, "packages/protocol/dist") };
}

function isNested(parent, child) {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

async function optionalStat(path) {
  try { return await lstat(path); } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}

async function listFiles(root, excludeVendor = false) {
  const files = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = resolve(root, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Build output must not contain symbolic links: ${path}`);
    if (excludeVendor && entry.name === "vendor") continue;
    if (entry.name === "node_modules") throw new Error(`Build output must not contain node_modules: ${path}`);
    if (entry.isDirectory()) files.push(...await listFiles(path, excludeVendor));
    else if (entry.isFile()) files.push(path);
    else throw new Error(`Unsupported build output: ${path}`);
  }
  return files;
}

export function rewriteProtocolSpecifiers(source, filePath, extensionDist) {
  // 复用 TypeScript AST 区分模块引用、注释和业务字符串，避免自制词法解析器。
  const tree = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true);
  const replacements = [];
  const collect = (literal) => {
    if (!literal || !ts.isStringLiteral(literal)) return;
    const specifier = literal.text;
    if (specifier !== PACKAGE && !specifier.startsWith(`${PACKAGE}/`)) return;
    const entry = specifier.slice(PACKAGE.length + 1);
    if (!ENTRIES.has(entry)) throw new Error(`Unknown protocol entry: ${specifier}`);
    let path = relative(dirname(filePath), resolve(extensionDist, "vendor/protocol", entry, "index.js")).replaceAll("\\", "/");
    if (!path.startsWith(".")) path = `./${path}`;
    replacements.push({ start: literal.getStart(tree), end: literal.end, text: JSON.stringify(path) });
  };
  const visit = (node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) collect(node.moduleSpecifier);
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) collect(node.argument.literal);
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) collect(node.arguments[0]);
    ts.forEachChild(node, visit);
  };
  visit(tree);
  let result = source;
  for (const change of replacements.sort((a, b) => b.start - a.start)) {
    result = result.slice(0, change.start) + change.text + result.slice(change.end);
  }
  return result;
}

export async function vendorProtocol({ extensionDist, protocolDist }) {
  extensionDist = resolve(extensionDist);
  protocolDist = resolve(protocolDist);
  if (isNested(extensionDist, protocolDist) || isNested(protocolDist, extensionDist)) {
    throw new Error("Extension and protocol outputs must not overlap");
  }
  for (const path of [extensionDist, protocolDist]) {
    if (!(await optionalStat(path))?.isDirectory()) throw new Error(`Missing build directory: ${path}`);
  }
  for (const entry of ENTRIES) for (const suffix of ["js", "d.ts"]) {
    const path = resolve(protocolDist, entry, `index.${suffix}`);
    if (!(await optionalStat(path))?.isFile()) throw new Error(`Missing protocol build entry: ${path}`);
  }
  const protocolFiles = await listFiles(protocolDist);
  for (const path of protocolFiles) {
    if (!/\.(?:js|d\.ts)$/.test(path) || /\.(?:test|spec)\./.test(path)) throw new Error(`Unexpected protocol build file: ${path}`);
  }
  const extensionFiles = await listFiles(extensionDist, true);
  const rewrites = [];
  for (const path of extensionFiles.filter((file) => /\.(?:js|d\.ts)$/.test(file))) {
    const source = await readFile(path, "utf8");
    const output = rewriteProtocolSpecifiers(source, path, extensionDist);
    if (source !== output) rewrites.push({ path, output });
  }
  // 入口和所有引用预检完成后，才替换本脚本唯一拥有的 vendor 子目录。
  const destination = resolve(extensionDist, "vendor/protocol");
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  for (const file of protocolFiles) {
    const target = resolve(destination, relative(protocolDist, file));
    await mkdir(dirname(target), { recursive: true });
    await cp(file, target);
  }
  for (const { path, output } of rewrites) await writeFile(path, output);
  return { rewrittenFiles: rewrites.map(({ path }) => path), vendorProtocolDirectory: destination };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  vendorProtocol(resolveVendorProtocolPaths()).catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
