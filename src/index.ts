/**
 * Host half of `dsh-pgadmin`.
 *
 * The panel must work without the user starting anything, so this side owns
 * both pieces pgAdmin needs:
 *
 * 1. **The process.** Opening the panel starts `pgadmin4` (unless one is
 *    already listening), waits for it, and stops it again when the plugin
 *    unloads. Nothing is left for the user to launch or manage.
 * 2. **The frame.** pgAdmin answers every response with
 *    `X-Frame-Options: SAMEORIGIN`, which no page on another origin may embed.
 *    The loopback proxy forwards requests unchanged and removes that one
 *    header, so the Web GUI can frame pgAdmin without touching its config.
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type Server,
  type ServerResponse,
} from 'node:http'
import { connect, type Socket } from 'node:net'

/** Plugin configuration, every key optional. */
export interface PgAdminConfig {
  /** pgAdmin 4 web server to forward to. Default `http://127.0.0.1:5050`. */
  readonly upstream?: string
  /** Loopback interface the proxy binds. Default `127.0.0.1`. */
  readonly host?: string
  /** Port the sidebar frames. Default `5051`; `0` binds an ephemeral port. */
  readonly port?: number
  /**
   * Start {@link PgAdminConfig.command} when nothing answers upstream. Default
   * `true`; set `false` to use only a pgAdmin you start yourself.
   */
  readonly autostart?: boolean
  /** Command started by `autostart`. Default `pgadmin4`. */
  readonly command?: string
  /** Arguments for `command`. Default `[]`. */
  readonly commandArgs?: readonly string[]
  /**
   * First-run account for a pgAdmin database that has no user yet. Passed to
   * the child as `PGADMIN_SETUP_EMAIL` / `PGADMIN_SETUP_PASSWORD`, which turns
   * pgAdmin's interactive setup prompt into a non-interactive creation.
   * Ignored once the database has a user.
   */
  readonly setupEmail?: string
  /** Password for {@link PgAdminConfig.setupEmail}. */
  readonly setupPassword?: string
  /**
   * Sources appended to the `frame-ancestors` directive of pgAdmin's CSP, for
   * example `['http://127.0.0.1:8080']`. Default `[]` leaves the CSP untouched.
   */
  readonly frameAncestors?: readonly string[]
}

/** A running proxy. */
export interface PgAdminProxy {
  /** Origin the sidebar frames, for example `http://127.0.0.1:5051`. */
  readonly url: string
  /** Settles once the proxy accepts connections; rejects when it cannot bind. */
  readonly ready: Promise<void>
  /** Stop accepting connections, drop open ones, and stop a pgAdmin this proxy started. */
  close(): void
}

/** Per-connection headers, never forwarded verbatim. */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

/** How long one upstream reachability probe waits. */
const PROBE_TIMEOUT_MS = 400

/** How long a started pgAdmin may take to accept connections. */
const START_TIMEOUT_MS = 45_000

/** How much of the child's stderr is kept for the failure page. */
const STDERR_TAIL = 2_000

/** Everything {@link createPgAdminProxy} derives from {@link PgAdminConfig}. */
interface ResolvedConfig {
  upstream: URL
  host: string
  port: number
  autostart: boolean
  command: string
  commandArgs: readonly string[]
  setupEmail: string
  setupPassword: string
  frameAncestors: readonly string[]
  origin: string
}

/**
 * Validate configuration and fill the defaults.
 * @param raw - the plugin entry's `config`, possibly empty.
 * @returns the effective configuration.
 */
function resolveConfig(raw: PgAdminConfig): ResolvedConfig {
  const upstream = new URL(raw.upstream ?? 'http://127.0.0.1:5050')
  if (upstream.protocol !== 'http:' && upstream.protocol !== 'https:') {
    throw new Error(`dsh-pgadmin: config.upstream must be an http(s) URL, got ${upstream.href}`)
  }
  const port = raw.port ?? 5051
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`dsh-pgadmin: config.port must be 0-65535, got ${String(raw.port)}`)
  }
  const commandArgs = [...(raw.commandArgs ?? [])]
  for (const argument of commandArgs) {
    if (typeof argument !== 'string') throw new Error('dsh-pgadmin: config.commandArgs must be strings')
  }
  return {
    upstream,
    host: raw.host ?? '127.0.0.1',
    port,
    autostart: raw.autostart ?? true,
    command: raw.command ?? 'pgadmin4',
    commandArgs,
    setupEmail: raw.setupEmail ?? '',
    setupPassword: raw.setupPassword ?? '',
    frameAncestors: [...(raw.frameAncestors ?? [])],
    origin: upstream.origin,
  }
}

/**
 * The port the upstream listens on, from an explicit port or the scheme.
 * @param upstream - the parsed upstream URL.
 * @returns the port number.
 */
function upstreamPort(upstream: URL): number {
  if (upstream.port !== '') return Number(upstream.port)
  return upstream.protocol === 'https:' ? 443 : 80
}

/**
 * Request path for the upstream, honouring a mount prefix such as `/pgadmin/`.
 * @param upstream - the parsed upstream URL.
 * @param path - the incoming request target.
 * @returns the path to request upstream.
 */
function upstreamPath(upstream: URL, path: string): string {
  const prefix = upstream.pathname.replace(/\/$/, '')
  const suffix = path.startsWith('/') ? path : `/${path}`
  return `${prefix}${suffix}`
}

/**
 * Rewrite an absolute URL that points at the upstream so it points at the
 * proxy instead; relative references stay as they are.
 * @param value - a `Location` value.
 * @param config - the effective configuration.
 * @param selfOrigin - the proxy origin.
 * @returns the rewritten value.
 */
function rewriteAbsolute(value: string, config: ResolvedConfig, selfOrigin: string): string {
  if (value.startsWith(config.origin)) return `${selfOrigin}${value.slice(config.origin.length)}`
  return value
}

/**
 * Copy request headers for the upstream: drop hop-by-hop fields, point `Host`
 * at the upstream, and present the upstream origin the way a direct visit
 * would so pgAdmin's CSRF checks see a consistent origin.
 * @param headers - headers received from the browser.
 * @param config - the effective configuration.
 * @returns headers to send upstream.
 */
function requestHeaders(headers: IncomingHttpHeaders, config: ResolvedConfig): OutgoingHttpHeaders {
  const out: Record<string, string | string[]> = {}
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || HOP_BY_HOP.has(name.toLowerCase())) continue
    out[name] = value
  }
  out.host = config.upstream.host
  if (out.origin !== undefined) out.origin = config.origin
  if (typeof out.referer === 'string') out.referer = config.origin + new URL(out.referer).pathname
  return out
}

/**
 * Copy response headers for the browser: drop hop-by-hop fields, drop
 * `X-Frame-Options`, optionally narrow framing with `frame-ancestors`, and
 * keep same-upstream redirects on the proxy.
 * @param headers - headers received from the upstream.
 * @param config - the effective configuration.
 * @param selfOrigin - the proxy origin.
 * @returns headers to send to the browser.
 */
function responseHeaders(headers: IncomingHttpHeaders, config: ResolvedConfig, selfOrigin: string): OutgoingHttpHeaders {
  const out: Record<string, string | string[]> = {}
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue
    const lower = name.toLowerCase()
    if (HOP_BY_HOP.has(lower) || lower === 'x-frame-options') continue
    if (lower === 'location' && typeof value === 'string') {
      out[name] = rewriteAbsolute(value, config, selfOrigin)
      continue
    }
    out[name] = value
  }
  if (config.frameAncestors.length > 0) {
    const sources = config.frameAncestors.join(' ')
    const existing = out['content-security-policy']
    if (typeof existing === 'string') out['content-security-policy'] = `${existing.replace(/;\s*$/, '')}; frame-ancestors ${sources}`
    else out['content-security-policy'] = `frame-ancestors ${sources}`
  }
  return out
}

/**
 * Escape text for the status page.
 * @param value - raw text.
 * @returns the same text, HTML-escaped.
 */
function escapeHtml(value: string): string {
  return value.replace(/[<>&]/g, character => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[character] ?? character)
}

/**
 * HTML shown inside the sidebar while pgAdmin is unavailable.
 * @param config - the effective configuration.
 * @param title - the headline.
 * @param detail - what failed, in one sentence.
 * @param log - the child's captured stderr, when there is any.
 * @returns a complete HTML document.
 */
function statusPage(config: ResolvedConfig, title: string, detail: string, log: string): string {
  const command = [config.command, ...config.commandArgs].join(' ')
  const needsSetup = log.includes('EOFError')
  const hint = needsSetup
    ? '<p>This pgAdmin database has no user yet, so pgAdmin asked for one on stdin. Set <code>setupEmail</code> and <code>setupPassword</code> in this plugin\'s config to create it, or run <code>pgadmin4</code> once with <code>PGADMIN_SETUP_EMAIL</code> and <code>PGADMIN_SETUP_PASSWORD</code> set.</p>'
    : ''
  const body = log.trim() === '' ? '' : `<pre>${escapeHtml(log.trim().slice(-1200))}</pre>`
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
  <p>Upstream <code>${escapeHtml(config.upstream.origin + config.upstream.pathname)}</code> · command <code>${escapeHtml(command)}</code></p>
  ${body}
</main>
`
}

/**
 * Serve the status page.
 * @param response - the browser response to write.
 * @param config - the effective configuration.
 * @param title - the headline.
 * @param detail - what failed, in one sentence.
 * @param log - the child's captured stderr, when there is any.
 */
function sendStatus(response: ServerResponse, config: ResolvedConfig, title: string, detail: string, log = ''): void {
  if (response.headersSent) {
    response.destroy()
    return
  }
  response.writeHead(502, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
  })
  response.end(statusPage(config, title, detail, log))
}

/** Prefix of the panel's own control endpoints, served by the same proxy. */
const CONTROL_PREFIX = '/__dsh-pgadmin/'

/**
 * Origins allowed to call the control endpoints: the GUI on loopback. A
 * browser page on this machine is the only caller that has business here.
 * @param origin - the request's `Origin` header.
 * @returns the value to echo back, or `undefined` when the caller is foreign.
 */
function allowedOrigin(origin: string | undefined): string | undefined {
  if (origin === undefined) return undefined
  return /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(origin) ? origin : undefined
}

/**
 * Test whether the upstream accepts a TCP connection.
 * @param config - the effective configuration.
 * @returns whether the upstream is reachable.
 */
function reachable(config: ResolvedConfig): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: config.upstream.hostname, port: upstreamPort(config.upstream) })
    const settle = (value: boolean): void => {
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(PROBE_TIMEOUT_MS, () => settle(false))
    socket.once('error', () => settle(false))
    socket.once('connect', () => settle(true))
  })
}

/**
 * Start the proxy, owning the pgAdmin it launches.
 * @param raw - the plugin entry's `config`, possibly empty.
 * @returns the running proxy.
 */
export function createPgAdminProxy(raw: PgAdminConfig = {}): PgAdminProxy {
  const config = resolveConfig(raw)
  let selfOrigin = `http://${config.host}:${config.port}`
  let child: ChildProcess | undefined
  let stderrTail = ''
  const sockets = new Set<Socket>()

  /** Stop the pgAdmin this proxy started; a pgAdmin it only found keeps running. */
  const stopChild = (): void => {
    const spawned = child
    child = undefined
    if (spawned?.pid === undefined) return
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(spawned.pid), '/T', '/F'], { stdio: 'ignore' })
    else spawned.kill('SIGTERM')
  }

  /** Launch pgAdmin once; its stderr tail explains a failed start. */
  const startChild = (): void => {
    // A Windows `.bat`/`.cmd` shim needs a shell; a real executable does not,
    // and spawning it directly keeps the pid we later stop.
    const throughShell = process.platform === 'win32' && !/\.exe$/i.test(config.command)
    const environment = { ...process.env }
    // A database with no user makes pgAdmin's migration prompt on stdin, which
    // a detached child does not have; these turn that prompt into creation.
    if (config.setupEmail !== '') environment.PGADMIN_SETUP_EMAIL = config.setupEmail
    if (config.setupPassword !== '') environment.PGADMIN_SETUP_PASSWORD = config.setupPassword
    const spawned = spawn(config.command, [...config.commandArgs], {
      shell: throughShell,
      env: environment,
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    })
    child = spawned
    spawned.stderr?.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-STDERR_TAIL)
    })
    spawned.once('error', (error: Error) => {
      stderrTail = `cannot start ${config.command}: ${error.message}`
      if (child === spawned) child = undefined
    })
    spawned.once('exit', (code) => {
      if (child === spawned) child = undefined
      if (code !== null && code !== 0) stderrTail = `${stderrTail}\n${config.command} exited with code ${String(code)}`.trim()
    })
  }

  /** Resolve once pgAdmin answers, starting it when configured to. */
  const ensureUpstream = async (): Promise<{ ok: true } | { ok: false; title: string; detail: string }> => {
    if (await reachable(config)) return { ok: true }
    if (!config.autostart) {
      return {
        ok: false,
        title: 'pgAdmin 4 is not reachable',
        detail: `Nothing is listening on ${config.upstream.hostname}:${String(upstreamPort(config.upstream))}, and config.autostart is off.`,
      }
    }
    if (child === undefined) startChild()
    const deadline = Date.now() + START_TIMEOUT_MS
    while (Date.now() < deadline) {
      if (await reachable(config)) return { ok: true }
      if (child === undefined && stderrTail.trim() !== '') {
        return { ok: false, title: 'pgAdmin 4 did not start', detail: `${config.command} stopped before its web server came up.` }
      }
      await new Promise(resolve => setTimeout(resolve, 250))
    }
    return {
      ok: false,
      title: 'pgAdmin 4 did not start in time',
      detail: `${config.command} was started but did not answer within ${String(START_TIMEOUT_MS / 1000)}s.`,
    }
  }

  /** Answer one control request: status, start, or stop. */
  const handleControl = (request: IncomingMessage, response: ServerResponse): void => {
    const route = (request.url ?? '').slice(CONTROL_PREFIX.length).split('?')[0] ?? ''
    const origin = allowedOrigin(request.headers.origin)
    const reply = (status: number, body: unknown): void => {
      const headers: Record<string, string> = {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      }
      if (origin !== undefined) {
        headers['access-control-allow-origin'] = origin
        headers['access-control-allow-methods'] = 'GET, POST, OPTIONS'
        headers['access-control-allow-headers'] = 'content-type'
        headers.vary = 'origin'
      }
      response.writeHead(status, headers)
      response.end(JSON.stringify(body))
    }
    if (request.method === 'OPTIONS') {
      reply(204, {})
      return
    }
    if (route === 'status') {
      void reachable(config).then((running) => {
        reply(200, { running, autostart: config.autostart, upstream: config.upstream.origin })
      })
      return
    }
    if (route === 'start') {
      void ensureUpstream().then((state) => {
        reply(state.ok ? 200 : 502, state.ok ? { ok: true, running: true } : { ok: false, title: state.title, detail: state.detail })
      })
      return
    }
    if (route === 'stop') {
      stopChild()
      void (async () => {
        const deadline = Date.now() + 5_000
        while (Date.now() < deadline && await reachable(config)) {
          await new Promise(resolve => setTimeout(resolve, 200))
        }
        reply(200, { ok: true, running: await reachable(config) })
      })()
      return
    }
    reply(404, { ok: false, detail: `unknown control route ${route}` })
  }

  /** Forward one HTTP request to the upstream, streaming both ways. */
  const forward = (request: IncomingMessage, response: ServerResponse): void => {
    const headers = requestHeaders(request.headers, config)
    headers['x-forwarded-host'] = request.headers.host ?? selfOrigin
    headers['x-forwarded-proto'] = 'http'
    const upstream = httpRequest({
      protocol: config.upstream.protocol,
      hostname: config.upstream.hostname,
      port: upstreamPort(config.upstream),
      method: request.method,
      path: upstreamPath(config.upstream, request.url ?? '/'),
      headers,
    }, (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders(upstreamResponse.headers, config, selfOrigin))
      upstreamResponse.pipe(response)
    })
    upstream.once('error', (error: Error) => sendStatus(response, config, 'pgAdmin 4 stopped answering', error.message, stderrTail))
    request.pipe(upstream)
  }

  const server: Server = createServer((request, response) => {
    if ((request.url ?? '').startsWith(CONTROL_PREFIX)) {
      handleControl(request, response)
      return
    }
    void ensureUpstream().then((state) => {
      if (!state.ok) {
        sendStatus(response, config, state.title, state.detail, stderrTail)
        return
      }
      forward(request, response)
    })
  })

  // pgAdmin keeps no WebSocket in normal use, but a proxied origin that drops
  // upgrades would break any extension or future feature that adds one.
  server.on('upgrade', (request, socket: Socket, head: Buffer) => {
    const upstream = connect({ host: config.upstream.hostname, port: upstreamPort(config.upstream) }, () => {
      const lines = [`${request.method ?? 'GET'} ${upstreamPath(config.upstream, request.url ?? '/')} HTTP/1.1`]
      for (const [name, value] of Object.entries(request.headers)) {
        if (value === undefined || name.toLowerCase() === 'host') continue
        for (const item of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${item}`)
      }
      lines.push(`host: ${config.upstream.host}`, '', '')
      upstream.write(lines.join('\r\n'))
      if (head.length > 0) upstream.write(head)
      upstream.pipe(socket)
      socket.pipe(upstream)
    })
    const drop = (): void => {
      upstream.destroy()
      socket.destroy()
    }
    upstream.once('error', drop)
    socket.once('error', drop)
  })

  server.on('connection', (socket: Socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })

  // A harness that exits without unloading the plugin must not leave pgAdmin
  // behind; close() removes this listener again.
  const onExit = (): void => stopChild()

  const ready = new Promise<void>((resolve, reject) => {
    server.once('error', (error: Error) => reject(new Error(`dsh-pgadmin: cannot bind ${selfOrigin}: ${error.message}`)))
    server.listen(config.port, config.host, () => {
      const address = server.address()
      if (typeof address === 'object' && address !== null) {
        selfOrigin = `http://${config.host}:${String(address.port)}`
      }
      process.once('exit', onExit)
      resolve()
    })
  })

  return {
    get url(): string {
      return selfOrigin
    },
    ready,
    close(): void {
      process.removeListener('exit', onExit)
      stopChild()
      server.close()
      for (const socket of sockets) socket.destroy()
      sockets.clear()
    },
  }
}

/** Plugin name. */
export const name = 'dsh-pgadmin'

/** The minimal Cordis surface this plugin uses. */
interface HostContext {
  effect(execute: () => () => void, label?: string): unknown
}

/**
 * Start the sidebar proxy and stop it — with any pgAdmin it started — when the
 * plugin fiber disposes.
 * @param ctx - Host plugin context.
 * @param config - the plugin entry's configuration.
 */
export async function apply(ctx: HostContext, config: PgAdminConfig = {}): Promise<void> {
  const proxy = createPgAdminProxy(config)
  ctx.effect(() => () => proxy.close(), 'dsh-pgadmin: proxy')
  await proxy.ready
  console.log(`[dsh-pgadmin] framing ${String(config.upstream ?? 'http://127.0.0.1:5050')} at ${proxy.url}`)
}
