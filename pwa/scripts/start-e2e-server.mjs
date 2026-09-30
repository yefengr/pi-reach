import { stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { preview } from "vite";

import { pwaRoutingPlugin } from "./pwa-routing.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const pwaDirectory = resolve(scriptDirectory, "..");

/**
 * @typedef {object} StaticPreviewOptions
 * @property {string} [root]
 * @property {string} [host]
 * @property {number | string} [port]
 */

/**
 * @param {number | string | undefined} value
 * @param {boolean} allowZero
 */
function parsePort(value, allowZero) {
  const candidate = value ?? "3000";
  if (
    (typeof candidate === "string" && !/^\d+$/.test(candidate)) ||
    (typeof candidate !== "string" && typeof candidate !== "number")
  ) {
    throw new Error(`Invalid PORT: ${String(candidate)}`);
  }

  const port = Number(candidate);
  const minimum = allowZero ? 0 : 1;
  if (!Number.isInteger(port) || port < minimum || port > 65_535) {
    throw new Error(`Invalid PORT: ${String(candidate)}`);
  }
  return port;
}

/** @param {string} path */
async function requireFile(path) {
  const details = await stat(path).catch(() => null);
  if (!details?.isFile()) {
    throw new Error(`Missing production build file: ${path}`);
  }
}

/**
 * Start the built PWA with Vite's local preview server.
 *
 * @param {StaticPreviewOptions} [options]
 * @returns {Promise<import("vite").PreviewServer>}
 */
export async function startStaticPreview(options = {}) {
  const root = resolve(options.root ?? pwaDirectory);
  const explicitPort = options.port !== undefined;
  const port = parsePort(options.port ?? process.env.PORT, explicitPort && options.port === 0);
  const host = options.host ?? process.env.HOSTNAME ?? "127.0.0.1";

  await requireFile(join(root, "dist", "index.html"));

  return preview({
    appType: "mpa",
    build: {
      outDir: "dist",
    },
    configFile: false,
    plugins: [pwaRoutingPlugin()],
    preview: {
      host,
      port,
      strictPort: true,
    },
    root,
  });
}

/** @param {import("vite").PreviewServer} server */
function closePreviewServer(server) {
  return new Promise((resolveClose, rejectClose) => {
    if (!server.httpServer.listening) {
      resolveClose();
      return;
    }
    server.httpServer.close((error) => {
      if (error) rejectClose(error);
      else resolveClose();
    });
  });
}

export async function main() {
  const server = await startStaticPreview();
  server.printUrls();

  let closing = false;
  const close = () => {
    if (closing) return;
    closing = true;
    process.off("SIGINT", close);
    process.off("SIGTERM", close);
    void closePreviewServer(server).catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
  };

  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}

const entrypoint = process.argv[1] ? resolve(process.argv[1]) : null;
if (entrypoint === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
