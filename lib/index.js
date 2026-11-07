// src/index.ts
import { spawn, spawnSync } from "node:child_process";
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
var START_TIMEOUT_MS = 45e3;
var STDERR_TAIL = 2e3;
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
    autostart: raw.autostart ?? true,
    command: raw.command ?? "pgadmin4",
    commandArgs,
    setupEmail: raw.setupEmail ?? "",
    setupPassword: raw.setupPassword ?? "",
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
function escapeHtml(value) {
  return value.replace(/[<>&]/g, (character) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[character] ?? character);
}
function statusPage(config, title, detail, log) {
  const command = [config.command, ...config.commandArgs].join(" ");
  const needsSetup = log.includes("EOFError");
  const hint = needsSetup ? "<p>This pgAdmin database has no user yet, so pgAdmin asked for one on stdin. Set <code>setupEmail</code> and <code>setupPassword</code> in this plugin's config to create it, or run <code>pgadmin4</code> once with <code>PGADMIN_SETUP_EMAIL</code> and <code>PGADMIN_SETUP_PASSWORD</code> set.</p>" : "";
  const body = log.trim() === "" ? "" : `<pre>${escapeHtml(log.trim().slice(-1200))}</pre>`;
  return `<!doctype html>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark }
  body {
    margin: 0; min-height: 100vh; display: grid; place-content: center; padding: 24px;
    font: 13px/1.6 ui-sans-serif, system-ui, sans-serif; background: #0d1117; color: #e6edf3;
  }
  main { max-width: 460px }
  h1 { font-size: 15px; margin: 0 0 8px }
  p { margin: 0 0 12px; color: #9da7b3 }
  code { font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; background: #161b22; padding: 2px 5px; border-radius: 4px }
  pre { margin: 12px 0 0; padding: 10px 12px; background: #161b22; border: 1px solid #30363d; border-radius: 6px; overflow: auto; font-size: 11px }
</style>
<main>
  <h1>${escapeHtml(title)}</h1>
  <p>${escapeHtml(detail)}</p>
  ${hint}
  <p>Upstream <code>${escapeHtml(config.upstream.origin + config.upstream.pathname)}</code> \xB7 command <code>${escapeHtml(command)}</code></p>
  ${body}
</main>
`;
}
function sendStatus(response, config, title, detail, log = "") {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  response.writeHead(502, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(statusPage(config, title, detail, log));
}
var CONTROL_PREFIX = "/__dsh-pgadmin/";
function allowedOrigin(origin) {
  if (origin === void 0) return void 0;
  return /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(origin) ? origin : void 0;
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
  let child;
  let stderrTail = "";
  const sockets = /* @__PURE__ */ new Set();
  const stopChild = () => {
    const spawned = child;
    child = void 0;
    if (spawned?.pid === void 0) return;
    if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(spawned.pid), "/T", "/F"], { stdio: "ignore" });
    else spawned.kill("SIGTERM");
  };
  const startChild = () => {
    const throughShell = process.platform === "win32" && !/\.exe$/i.test(config.command);
    const environment = { ...process.env };
    if (config.setupEmail !== "") environment.PGADMIN_SETUP_EMAIL = config.setupEmail;
    if (config.setupPassword !== "") environment.PGADMIN_SETUP_PASSWORD = config.setupPassword;
    const spawned = spawn(config.command, [...config.commandArgs], {
      shell: throughShell,
      env: environment,
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true
    });
    child = spawned;
    spawned.stderr?.on("data", (chunk) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-STDERR_TAIL);
    });
    spawned.once("error", (error) => {
      stderrTail = `cannot start ${config.command}: ${error.message}`;
      if (child === spawned) child = void 0;
    });
    spawned.once("exit", (code) => {
      if (child === spawned) child = void 0;
      if (code !== null && code !== 0) stderrTail = `${stderrTail}
${config.command} exited with code ${String(code)}`.trim();
    });
  };
  const ensureUpstream = async () => {
    if (await reachable(config)) return { ok: true };
    if (!config.autostart) {
      return {
        ok: false,
        title: "pgAdmin 4 is not reachable",
        detail: `Nothing is listening on ${config.upstream.hostname}:${String(upstreamPort(config.upstream))}, and config.autostart is off.`
      };
    }
    if (child === void 0) startChild();
    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (await reachable(config)) return { ok: true };
      if (child === void 0 && stderrTail.trim() !== "") {
        return { ok: false, title: "pgAdmin 4 did not start", detail: `${config.command} stopped before its web server came up.` };
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return {
      ok: false,
      title: "pgAdmin 4 did not start in time",
      detail: `${config.command} was started but did not answer within ${String(START_TIMEOUT_MS / 1e3)}s.`
    };
  };
  const handleControl = (request, response) => {
    const route = (request.url ?? "").slice(CONTROL_PREFIX.length).split("?")[0] ?? "";
    const origin = allowedOrigin(request.headers.origin);
    const reply = (status, body) => {
      const headers = {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store"
      };
      if (origin !== void 0) {
        headers["access-control-allow-origin"] = origin;
        headers["access-control-allow-methods"] = "GET, POST, OPTIONS";
        headers["access-control-allow-headers"] = "content-type";
        headers.vary = "origin";
      }
      response.writeHead(status, headers);
      response.end(JSON.stringify(body));
    };
    if (request.method === "OPTIONS") {
      reply(204, {});
      return;
    }
    if (route === "status") {
      void reachable(config).then((running) => {
        reply(200, { running, autostart: config.autostart, upstream: config.upstream.origin });
      });
      return;
    }
    if (route === "start") {
      void ensureUpstream().then((state) => {
        reply(state.ok ? 200 : 502, state.ok ? { ok: true, running: true } : { ok: false, title: state.title, detail: state.detail });
      });
      return;
    }
    if (route === "stop") {
      stopChild();
      void (async () => {
        const deadline = Date.now() + 5e3;
        while (Date.now() < deadline && await reachable(config)) {
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
        reply(200, { ok: true, running: await reachable(config) });
      })();
      return;
    }
    reply(404, { ok: false, detail: `unknown control route ${route}` });
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
    upstream.once("error", (error) => sendStatus(response, config, "pgAdmin 4 stopped answering", error.message, stderrTail));
    request.pipe(upstream);
  };
  const server = createServer((request, response) => {
    if ((request.url ?? "").startsWith(CONTROL_PREFIX)) {
      handleControl(request, response);
      return;
    }
    void ensureUpstream().then((state) => {
      if (!state.ok) {
        sendStatus(response, config, state.title, state.detail, stderrTail);
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
  const onExit = () => stopChild();
  const ready = new Promise((resolve, reject) => {
    server.once("error", (error) => reject(new Error(`dsh-pgadmin: cannot bind ${selfOrigin}: ${error.message}`)));
    server.listen(config.port, config.host, () => {
      const address = server.address();
      if (typeof address === "object" && address !== null) {
        selfOrigin = `http://${config.host}:${String(address.port)}`;
      }
      process.once("exit", onExit);
      resolve();
    });
  });
  return {
    get url() {
      return selfOrigin;
    },
    ready,
    close() {
      process.removeListener("exit", onExit);
      stopChild();
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
  console.log(`[dsh-pgadmin] framing ${String(config.upstream ?? "http://127.0.0.1:5050")} at ${proxy.url}`);
}
export {
  apply,
  createPgAdminProxy,
  name
};
