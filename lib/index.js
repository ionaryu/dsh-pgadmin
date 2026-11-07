// src/index.ts
import { spawn } from "node:child_process";
import {
  createServer,
  request as httpRequest
} from "node:http";
import { connect } from "node:net";
var HOP_BY_HOP = /* @__PURE__ */ new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade"
]);
var PROBE_TIMEOUT_MS = 400;
var START_TIMEOUT_MS = 2e4;
function resolveConfig(raw) {
  const upstream = new URL(raw.upstream ?? "http://127.0.0.1:5050");
  if (upstream.protocol !== "http:" && upstream.protocol !== "https:") {
    throw new Error(`dsh-pgadmin: config.upstream must be an http(s) URL, got ${upstream.href}`);
  }
  const port = raw.port ?? 5051;
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`dsh-pgadmin: config.port must be 0-65535, got ${String(raw.port)}`);
  }
  const commandArgs = [...raw.commandArgs ?? []];
  for (const argument of commandArgs) {
    if (typeof argument !== "string") throw new Error("dsh-pgadmin: config.commandArgs must be strings");
  }
  return {
    upstream,
    host: raw.host ?? "127.0.0.1",
    port,
    autostart: raw.autostart ?? false,
    command: raw.command ?? "pgadmin4",
    commandArgs,
    frameAncestors: [...raw.frameAncestors ?? []],
    origin: upstream.origin
  };
}
function upstreamPort(upstream) {
  if (upstream.port !== "") return Number(upstream.port);
  return upstream.protocol === "https:" ? 443 : 80;
}
function upstreamPath(upstream, path) {
  const prefix = upstream.pathname.replace(/\/$/, "");
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${prefix}${suffix}`;
}
function rewriteAbsolute(value, config, selfOrigin) {
  if (value.startsWith(config.origin)) return `${selfOrigin}${value.slice(config.origin.length)}`;
  return value;
}
function requestHeaders(headers, config) {
  const out = {};
  for (const [name2, value] of Object.entries(headers)) {
    if (value === void 0 || HOP_BY_HOP.has(name2.toLowerCase())) continue;
    out[name2] = value;
  }
  out.host = config.upstream.host;
  if (out.origin !== void 0) out.origin = config.origin;
  if (typeof out.referer === "string") out.referer = config.origin + new URL(out.referer).pathname;
  return out;
}
function responseHeaders(headers, config, selfOrigin) {
  const out = {};
  for (const [name2, value] of Object.entries(headers)) {
    if (value === void 0) continue;
    const lower = name2.toLowerCase();
    if (HOP_BY_HOP.has(lower) || lower === "x-frame-options") continue;
    if (lower === "location" && typeof value === "string") {
      out[name2] = rewriteAbsolute(value, config, selfOrigin);
      continue;
    }
    out[name2] = value;
  }
  if (config.frameAncestors.length > 0) {
    const sources = config.frameAncestors.join(" ");
    const existing = out["content-security-policy"];
    if (typeof existing === "string") out["content-security-policy"] = `${existing.replace(/;\s*$/, "")}; frame-ancestors ${sources}`;
    else out["content-security-policy"] = `frame-ancestors ${sources}`;
  }
  return out;
}
function offlinePage(config, detail) {
  const start = [config.command, ...config.commandArgs].join(" ");
  return `<!doctype html>
<meta charset="utf-8">
<title>pgAdmin 4 is not reachable</title>
<style>
  :root { color-scheme: light dark }
  body {
    margin: 0; min-height: 100vh; display: grid; place-content: center; padding: 24px;
    font: 13px/1.6 ui-sans-serif, system-ui, sans-serif;
    background: #0d1117; color: #e6edf3;
  }
  main { max-width: 420px }
  h1 { font-size: 15px; margin: 0 0 8px }
  p { margin: 0 0 12px; color: #9da7b3 }
  code { font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; background: #161b22; padding: 2px 5px; border-radius: 4px }
  pre { margin: 0 0 12px; padding: 10px 12px; background: #161b22; border: 1px solid #30363d; border-radius: 6px; overflow: auto }
</style>
<main>
  <h1>pgAdmin 4 is not reachable</h1>
  <p>The sidebar proxy could not connect to <code>${config.upstream.origin}${config.upstream.pathname}</code>.</p>
  <p>Start pgAdmin 4, then reload this page:</p>
  <pre>${start}</pre>
  <p>${detail}</p>
</main>
`;
}
function sendOffline(response, config, detail) {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  response.writeHead(502, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(offlinePage(config, detail.replace(/[<>&]/g, (character) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[character] ?? character)));
}
function reachable(config) {
  return new Promise((resolve) => {
    const socket = connect({ host: config.upstream.hostname, port: upstreamPort(config.upstream) });
    const settle = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(PROBE_TIMEOUT_MS, () => settle(false));
    socket.once("error", () => settle(false));
    socket.once("connect", () => settle(true));
  });
}
function createPgAdminProxy(raw = {}) {
  const config = resolveConfig(raw);
  let selfOrigin = `http://${config.host}:${config.port}`;
  let starting;
  let started = false;
  const sockets = /* @__PURE__ */ new Set();
  const ensureUpstream = async () => {
    if (await reachable(config)) return { ok: true };
    if (!config.autostart) {
      return { ok: false, detail: `Nothing is listening on ${config.upstream.hostname}:${String(upstreamPort(config.upstream))}. Set config.autostart to start it automatically.` };
    }
    if (!started) {
      started = true;
      starting ??= new Promise((resolve, reject) => {
        const child = spawn(config.command, [...config.commandArgs], { detached: true, stdio: "ignore", windowsHide: true });
        child.once("error", (error) => reject(new Error(`cannot start ${config.command}: ${error.message}`)));
        child.once("spawn", () => {
          child.unref();
          resolve();
        });
      }).catch((error) => {
        started = false;
        throw error;
      });
      try {
        await starting;
      } catch (error) {
        return { ok: false, detail: error instanceof Error ? error.message : String(error) };
      }
    }
    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (await reachable(config)) return { ok: true };
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return { ok: false, detail: `${config.command} did not start listening on ${config.upstream.host} within ${String(START_TIMEOUT_MS / 1e3)}s.` };
  };
  const forward = (request, response) => {
    const headers = requestHeaders(request.headers, config);
    headers["x-forwarded-host"] = request.headers.host ?? selfOrigin;
    headers["x-forwarded-proto"] = "http";
    const upstream = httpRequest({
      protocol: config.upstream.protocol,
      hostname: config.upstream.hostname,
      port: upstreamPort(config.upstream),
      method: request.method,
      path: upstreamPath(config.upstream, request.url ?? "/"),
      headers
    }, (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders(upstreamResponse.headers, config, selfOrigin));
      upstreamResponse.pipe(response);
    });
    upstream.once("error", (error) => sendOffline(response, config, error.message));
    request.pipe(upstream);
  };
  const server = createServer((request, response) => {
    void ensureUpstream().then((state) => {
      if (!state.ok) {
        sendOffline(response, config, state.detail);
        return;
      }
      forward(request, response);
    });
  });
  server.on("upgrade", (request, socket, head) => {
    const upstream = connect({ host: config.upstream.hostname, port: upstreamPort(config.upstream) }, () => {
      const lines = [`${request.method ?? "GET"} ${upstreamPath(config.upstream, request.url ?? "/")} HTTP/1.1`];
      for (const [name2, value] of Object.entries(request.headers)) {
        if (value === void 0 || name2.toLowerCase() === "host") continue;
        for (const item of Array.isArray(value) ? value : [value]) lines.push(`${name2}: ${item}`);
      }
      lines.push(`host: ${config.upstream.host}`, "", "");
      upstream.write(lines.join("\r\n"));
      if (head.length > 0) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    const drop = () => {
      upstream.destroy();
      socket.destroy();
    };
    upstream.once("error", drop);
    socket.once("error", drop);
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  const ready = new Promise((resolve, reject) => {
    server.once("error", (error) => reject(new Error(`dsh-pgadmin: cannot bind ${selfOrigin}: ${error.message}`)));
    server.listen(config.port, config.host, () => {
      const address = server.address();
      if (typeof address === "object" && address !== null) {
        selfOrigin = `http://${config.host}:${String(address.port)}`;
      }
      resolve();
    });
  });
  return {
    get url() {
      return selfOrigin;
    },
    ready,
    close() {
      server.close();
      for (const socket of sockets) socket.destroy();
      sockets.clear();
    }
  };
}
var name = "dsh-pgadmin";
async function apply(ctx, config = {}) {
  const proxy = createPgAdminProxy(config);
  ctx.effect(() => () => proxy.close(), "dsh-pgadmin: proxy");
  await proxy.ready;
  console.log(`[dsh-pgadmin] proxying ${String(config.upstream ?? "http://127.0.0.1:5050")} at ${proxy.url}`);
}
export {
  apply,
  createPgAdminProxy,
  name
};
