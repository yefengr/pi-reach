const APP_PATH = "/app";
const INDEX_PATH = "/index.html";
const MANIFEST_PATH = "/manifest.webmanifest";
const SERVICE_WORKER_PATH = "/sw.js";

const NO_CACHE = "no-cache";
const IMMUTABLE_CACHE = "public, max-age=31536000, immutable";

/**
 * 产品路由均位于 /app 下：/app 与 /app/<子路径> 都返回应用入口，由前端识别子路径。
 *
 * @param {string} pathname
 */
function isAppPage(pathname) {
  return pathname === APP_PATH || (pathname.startsWith(`${APP_PATH}/`) && pathname.length > APP_PATH.length + 1);
}

/**
 * @param {import("node:http").ServerResponse} response
 * @param {number} statusCode
 * @param {string} location
 */
function redirect(response, statusCode, location) {
  response.statusCode = statusCode;
  response.setHeader("Location", location);
  response.end();
}

/**
 * @param {string} pathname
 * @param {string} search
 */
function redirectLocation(pathname, search) {
  return `${pathname}${search}`;
}

/**
 * @param {import("node:http").ServerResponse} response
 * @param {string} pathname
 * @returns {Record<string, string>}
 */
function responseHeaders(response, pathname) {
  if (pathname === SERVICE_WORKER_PATH) {
    return {
      "Cache-Control": NO_CACHE,
      "Content-Type": "application/javascript; charset=utf-8",
    };
  }
  if (pathname === MANIFEST_PATH) {
    return {
      "Cache-Control": NO_CACHE,
      "Content-Type": "application/manifest+json; charset=utf-8",
    };
  }
  if (pathname.startsWith("/assets/")) {
    return { "Cache-Control": IMMUTABLE_CACHE };
  }

  const contentType = response.getHeader("Content-Type");
  if (
    isAppPage(pathname) ||
    pathname.endsWith(".html") ||
    (typeof contentType === "string" && contentType.startsWith("text/html"))
  ) {
    return { "Cache-Control": NO_CACHE };
  }
  return {};
}

/**
 * @param {import("node:http").OutgoingHttpHeaders | undefined} headers
 * @param {Record<string, string>} requiredHeaders
 */
function mergeHeaders(headers, requiredHeaders) {
  const merged = { ...headers };
  for (const [name, value] of Object.entries(requiredHeaders)) {
    for (const existingName of Object.keys(merged)) {
      if (existingName.toLowerCase() === name.toLowerCase()) delete merged[existingName];
    }
    merged[name] = value;
  }
  return merged;
}

/**
 * @param {import("node:http").ServerResponse} response
 * @param {string} pathname
 */
function installResponseHeaders(response, pathname) {
  const writeHead = response.writeHead;
  let applied = false;

  response.writeHead = function pwaWriteHead(statusCode, ...args) {
    const successful = (statusCode >= 200 && statusCode < 300) || statusCode === 304;
    if (applied || !successful) {
      return Reflect.apply(writeHead, this, [statusCode, ...args]);
    }

    applied = true;
    const requiredHeaders = responseHeaders(response, pathname);
    const headerIndex = typeof args[0] === "string" ? 1 : 0;
    const suppliedHeaders = args[headerIndex];
    if (suppliedHeaders && !Array.isArray(suppliedHeaders)) {
      args[headerIndex] = mergeHeaders(suppliedHeaders, requiredHeaders);
    } else {
      for (const [name, value] of Object.entries(requiredHeaders)) {
        response.setHeader(name, value);
      }
    }

    return Reflect.apply(writeHead, this, [statusCode, ...args]);
  };
}

/**
 * @returns {import("vite").Plugin}
 */
export function pwaRoutingPlugin() {
  /**
   * @typedef {(request: import("node:http").IncomingMessage, response: import("node:http").ServerResponse, next: () => void) => void} Middleware
   */

  /** @param {{ middlewares: { use: (middleware: Middleware) => void } }} server */
  const installMiddleware = (server) => {
    server.middlewares.use((request, response, next) => {
      let url;
      try {
        url = new URL(request.url ?? "/", "http://localhost");
      } catch {
        next();
        return;
      }

      const { pathname, search } = url;
      if (pathname === "/") {
        redirect(response, 307, redirectLocation(APP_PATH, search));
        return;
      }
      if (pathname === `${APP_PATH}/`) {
        redirect(response, 308, redirectLocation(APP_PATH, search));
        return;
      }
      if (pathname === INDEX_PATH) {
        redirect(response, 307, redirectLocation(APP_PATH, search));
        return;
      }

      installResponseHeaders(response, pathname);
      if (isAppPage(pathname)) {
        request.url = `${INDEX_PATH}${search}`;
      }
      next();
    });
  };

  return {
    name: "pi-reach-pwa-routing",
    enforce: "pre",
    configureServer: installMiddleware,
    configurePreviewServer: installMiddleware,
  };
}
