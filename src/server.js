import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CleverSQLError, clampInt, normalizeActor } from "./utils.js";
import { createMcpBridge } from "./mcp.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, "..", "public");
const MAX_BODY_BYTES = 1024 * 1024;

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function securityHeaders(contentType) {
  return {
    "Content-Type": contentType,
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store",
    "Content-Security-Policy":
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  };
}

function sendJson(response, status, body) {
  response.writeHead(status, securityHeaders("application/json; charset=utf-8"));
  response.end(JSON.stringify(body));
}

function sendEmpty(response, status = 204) {
  response.writeHead(status, securityHeaders("text/plain; charset=utf-8"));
  response.end();
}

function sendError(response, error) {
  const status = Number(error?.status) || 500;
  const code = error?.code ?? "INTERNAL_ERROR";
  const message =
    status >= 500 && !(error instanceof CleverSQLError)
      ? "Unexpected server error."
      : error?.message ?? "Unexpected server error.";
  sendJson(response, status, {
    error: {
      code,
      message,
      ...(error?.details ? { details: error.details } : {}),
    },
  });
}

async function readJsonBody(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      throw new CleverSQLError("Request body exceeds 1 MB.", {
        status: 413,
        code: "BODY_TOO_LARGE",
      });
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new CleverSQLError("Request body must be valid JSON.", {
      status: 400,
      code: "INVALID_JSON",
    });
  }
}

function authorized(request, token) {
  if (!token) return true;
  const header = request.headers.authorization ?? "";
  return header === `Bearer ${token}`;
}

function originAllowed(request) {
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === request.headers.host;
  } catch {
    return false;
  }
}

function contentType(request) {
  return String(request.headers["content-type"] ?? "")
    .split(";")[0]
    .trim()
    .toLowerCase();
}

function actorFrom(request, fallback = "human") {
  return normalizeActor(
    request.headers["x-cleversql-actor"],
    fallback,
  );
}

function requestOrigin(request) {
  const forwardedProto = String(request.headers["x-forwarded-proto"] ?? "")
    .split(",")[0]
    .trim();
  const protocol = forwardedProto || (request.socket.encrypted ? "https" : "http");
  return `${protocol}://${request.headers.host}`;
}

function serveStatic(request, response, pathname) {
  const requested = pathname === "/" ? "/index.html" : pathname;
  const decoded = decodeURIComponent(requested);
  const target = path.resolve(PUBLIC_DIR, `.${decoded}`);
  if (target !== PUBLIC_DIR && !target.startsWith(`${PUBLIC_DIR}${path.sep}`)) {
    throw new CleverSQLError("Not found.", { status: 404, code: "NOT_FOUND" });
  }
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
    throw new CleverSQLError("Not found.", { status: 404, code: "NOT_FOUND" });
  }
  const extension = path.extname(target).toLowerCase();
  const body = fs.readFileSync(target);
  response.writeHead(
    200,
    securityHeaders(MIME_TYPES[extension] ?? "application/octet-stream"),
  );
  response.end(body);
}

function connectPayload(request, cleversql, token, version) {
  const base = requestOrigin(request);
  const mcpUrl = `${base}/mcp`;
  const genericConfig = {
    mcpServers: {
      cleversql: {
        url: mcpUrl,
        ...(token
          ? {
              headers: {
                Authorization: "Bearer REPLACE_WITH_CLEVERSQL_TOKEN",
              },
            }
          : {}),
      },
    },
  };
  const codexConfig = `[mcp_servers.cleversql]
url = "${mcpUrl}"${token ? '\nbearer_token_env_var = "CLEVERSQL_TOKEN"' : ""}`;
  return {
    mcp: {
      name: "cleversql",
      transport: "streamable-http",
      url: mcpUrl,
      authentication: token ? "bearer" : "none",
    },
    tools: [
      "cleversql_overview",
      "cleversql_describe_table",
      "cleversql_browse_rows",
      "cleversql_query",
      "cleversql_preview_change",
      "cleversql_apply_change",
      "cleversql_list_changes",
      "cleversql_revert_change",
    ],
    configExample: genericConfig,
    clients: [
      {
        id: "codex",
        name: "Codex",
        format: "toml",
        location: "~/.codex/config.toml",
        command: `codex mcp add cleversql --url ${mcpUrl}`,
        config: codexConfig,
      },
      {
        id: "vscode",
        name: "VS Code",
        format: "json",
        location: ".vscode/mcp.json",
        config: {
          servers: {
            cleversql: {
              type: "http",
              url: mcpUrl,
              ...(token
                ? {
                    headers: {
                      Authorization: "Bearer REPLACE_WITH_CLEVERSQL_TOKEN",
                    },
                  }
                : {}),
            },
          },
        },
      },
      {
        id: "cursor",
        name: "Cursor",
        format: "json",
        location: ".cursor/mcp.json",
        config: genericConfig,
      },
      {
        id: "generic",
        name: "Generic MCP",
        format: "json",
        location: "mcp.json",
        config: genericConfig,
      },
    ],
    safety: {
      readOnly: cleversql.readOnly,
      maxRows: cleversql.maxRows,
      maxAffectedRows: cleversql.maxChanges,
      rawWriteSql: "blocked",
      protocol: "preview -> apply -> revert",
    },
    version,
  };
}

export async function startServer({
  cleversql,
  host = "127.0.0.1",
  port = 4310,
  token = null,
  version = "0.2.0",
}) {
  const mcp = createMcpBridge(cleversql, { version });

  const handler = async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", requestOrigin(request));
      const pathname = decodeURIComponent(url.pathname);

      if (pathname === "/health") {
        sendJson(response, 200, {
          ok: true,
          product: "CleverSQL",
          version,
          readOnly: cleversql.readOnly,
        });
        return;
      }

      const protectedRoute =
        pathname.startsWith("/api/") || pathname === "/mcp";
      if (protectedRoute && !authorized(request, token)) {
        sendJson(response, 401, {
          error: {
            code: "UNAUTHORIZED",
            message: "A bearer token is required.",
          },
        });
        return;
      }

      if (
        ["POST", "PUT", "PATCH", "DELETE"].includes(request.method) &&
        !originAllowed(request)
      ) {
        sendJson(response, 403, {
          error: {
            code: "ORIGIN_DENIED",
            message: "Cross-origin mutations are blocked.",
          },
        });
        return;
      }

      if (pathname === "/mcp") {
        if (request.method !== "POST") {
          response.setHeader("Allow", "POST");
          sendEmpty(response, 405);
          return;
        }
        if (contentType(request) !== "application/json") {
          throw new CleverSQLError("MCP requests must use application/json.", {
            status: 415,
            code: "UNSUPPORTED_MEDIA_TYPE",
          });
        }
        const body = await readJsonBody(request);
        const context = {
          actor: actorFrom(request, "mcp-agent"),
        };
        if (Array.isArray(body)) {
          const results = (
            await Promise.all(body.map((message) => mcp.handle(message, context)))
          ).filter(Boolean);
          if (results.length === 0) {
            sendEmpty(response, 202);
          } else {
            sendJson(response, 200, results);
          }
        } else {
          const result = await mcp.handle(body, context);
          if (result === null) {
            sendEmpty(response, 202);
          } else {
            sendJson(response, 200, result);
          }
        }
        return;
      }

      if (request.method === "GET" && pathname === "/api/dashboard") {
        sendJson(response, 200, await cleversql.dashboard());
        return;
      }

      if (request.method === "GET" && pathname === "/api/connect") {
        sendJson(
          response,
          200,
          connectPayload(request, cleversql, token, version),
        );
        return;
      }

      if (request.method === "GET" && pathname === "/api/tables") {
        sendJson(response, 200, { tables: await cleversql.tables() });
        return;
      }

      const tableMatch = pathname.match(/^\/api\/tables\/([^/]+)$/);
      if (request.method === "GET" && tableMatch) {
        sendJson(response, 200, await cleversql.table(tableMatch[1]));
        return;
      }

      const rowsMatch = pathname.match(/^\/api\/tables\/([^/]+)\/rows$/);
      if (request.method === "GET" && rowsMatch) {
        sendJson(
          response,
          200,
          await cleversql.browseTable(rowsMatch[1], {
            limit: clampInt(url.searchParams.get("limit"), 1, 200, 50),
            offset: clampInt(url.searchParams.get("offset"), 0, 1_000_000, 0),
          }),
        );
        return;
      }

      if (request.method === "POST" && pathname === "/api/query") {
        if (contentType(request) !== "application/json") {
          throw new CleverSQLError("Content-Type must be application/json.", {
            status: 415,
            code: "UNSUPPORTED_MEDIA_TYPE",
          });
        }
        const body = await readJsonBody(request);
        sendJson(response, 200, await cleversql.query(body.sql, body));
        return;
      }

      if (request.method === "GET" && pathname === "/api/changes") {
        sendJson(response, 200, {
          changes: cleversql.listChanges({
            status: url.searchParams.get("status") ?? "all",
            limit: clampInt(url.searchParams.get("limit"), 1, 100, 50),
          }),
        });
        return;
      }

      if (request.method === "POST" && pathname === "/api/changes/preview") {
        if (contentType(request) !== "application/json") {
          throw new CleverSQLError("Content-Type must be application/json.", {
            status: 415,
            code: "UNSUPPORTED_MEDIA_TYPE",
          });
        }
        const body = await readJsonBody(request);
        sendJson(
          response,
          201,
          await cleversql.previewChange(body, {
            actor: actorFrom(request),
          }),
        );
        return;
      }

      const changeMatch = pathname.match(/^\/api\/changes\/([^/]+)$/);
      if (request.method === "GET" && changeMatch) {
        sendJson(response, 200, cleversql.getChange(changeMatch[1]));
        return;
      }

      const applyMatch = pathname.match(/^\/api\/changes\/([^/]+)\/apply$/);
      if (request.method === "POST" && applyMatch) {
        sendJson(
          response,
          200,
          await cleversql.applyChange(applyMatch[1], {
            actor: actorFrom(request),
          }),
        );
        return;
      }

      const revertMatch = pathname.match(/^\/api\/changes\/([^/]+)\/revert$/);
      if (request.method === "POST" && revertMatch) {
        const body = await readJsonBody(request);
        sendJson(
          response,
          200,
          await cleversql.revertChange(revertMatch[1], {
            actor: actorFrom(request),
            reason: body.reason ?? "",
          }),
        );
        return;
      }

      if (pathname.startsWith("/api/")) {
        throw new CleverSQLError("API route not found.", {
          status: 404,
          code: "NOT_FOUND",
        });
      }

      if (request.method !== "GET" && request.method !== "HEAD") {
        throw new CleverSQLError("Method not allowed.", {
          status: 405,
          code: "METHOD_NOT_ALLOWED",
        });
      }
      serveStatic(request, response, pathname);
    } catch (error) {
      if (response.headersSent) {
        response.end();
        return;
      }
      sendError(response, error);
    }
  };

  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  const actualPort = typeof address === "object" ? address.port : port;
  const displayHost =
    host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  return {
    server,
    port: actualPort,
    url: `http://${displayHost}:${actualPort}`,
    async close() {
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
