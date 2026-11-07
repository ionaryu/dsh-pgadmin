/**
 * Host half of `dsh-pgadmin`.
 *
 * pgAdmin 4 answers every response with `X-Frame-Options: SAMEORIGIN`, so the
 * Web GUI (:8080) cannot embed it (:5050) — the browser refuses the frame
 * before pgAdmin renders anything. This side runs a loopback proxy in front of
 * pgAdmin that forwards requests unchanged and removes that one header, which
 * is the only thing standing between the app and the right sidebar.
 *
 * The proxy adds no authentication and listens on loopback only: it exposes
 * exactly what pgAdmin already exposes to this machine.
 */

import { spawn } from 'node:child_process'
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
  /** Spawn {@link PgAdminConfig.command} when nothing answers upstream. Default `false`. */
  readonly autostart?: boolean
  /** Command started by `autostart`. Default `pgadmin4`. */
  readonly command?: string
  /** Arguments for `command`. Default `[]`. */
  readonly commandArgs?: readonly string[]
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
  /** Stop accepting connections and drop the open ones. */
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

/** How long an `autostart` launch may take before the request gives up. */
const START_TIMEOUT_MS = 20_000

/** Everything {@link createPgAdminProxy} derives from {@link PgAdminConfig}. */
interface ResolvedConfig {
  upstream: URL
  host: string
  port: number
  autostart: boolean
  command: string
  commandArgs: readonly string[]
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
    autostart: raw.autostart ?? false,
    command: raw.command ?? 'pgadmin4',
    commandArgs,
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
 * @param value - a `Location` or `Referer` value.
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
 * HTML shown inside the sidebar when the upstream cannot be reached.
 * @param config - the effective configuration.
 * @param detail - the failure to report.
 * @returns a complete HTML document.
 */
function offlinePage(config: ResolvedConfig, detail: string): string {
  const start = [config.command, ...config.commandArgs].join(' ')
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
`
}

/**
 * Serve the offline page.
 * @param response - the browser response to write.
 * @param config - the effective configuration.
 * @param detail - the failure to report.
 */
function sendOffline(response: ServerResponse, config: ResolvedConfig, detail: string): void {
  if (response.headersSent) {
    response.destroy()
    return
  }
  response.writeHead(502, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
  })
  response.end(offlinePage(config, detail.replace(/[<>&]/g, character => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[character] ?? character)))
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
 * Start the proxy, optionally bringing pgAdmin up on first use.
 * @param raw - the plugin entry's `config`, possibly empty.
 * @returns the running proxy.
 */
export function createPgAdminProxy(raw: PgAdminConfig = {}): PgAdminProxy {
  const config = resolveConfig(raw)
  let selfOrigin = `http://${config.host}:${config.port}`
  let starting: Promise<void> | undefined
  let started = false
  const sockets = new Set<Socket>()

  /** Resolve once pgAdmin answers, launching it when configured to. */
  const ensureUpstream = async (): Promise<{ ok: true } | { ok: false; detail: string }> => {
    if (await reachable(config)) return { ok: true }
    if (!config.autostart) {
      return { ok: false, detail: `Nothing is listening on ${config.upstream.hostname}:${String(upstreamPort(config.upstream))}. Set config.autostart to start it automatically.` }
    }
    if (!started) {
      started = true
      starting ??= new Promise<void>((resolve, reject) => {
        const child = spawn(config.command, [...config.commandArgs], { detached: true, stdio: 'ignore', windowsHide: true })
        child.once('error', (error: Error) => reject(new Error(`cannot start ${config.command}: ${error.message}`)))
        child.once('spawn', () => {
          child.unref()
          resolve()
        })
      }).catch((error: unknown) => {
        started = false
        throw error
      })
      try {
        await starting
      } catch (error) {
        return { ok: false, detail: error instanceof Error ? error.message : String(error) }
      }
    }
    const deadline = Date.now() + START_TIMEOUT_MS
    while (Date.now() < deadline) {
      if (await reachable(config)) return { ok: true }
      await new Promise(resolve => setTimeout(resolve, 250))
    }
    return { ok: false, detail: `${config.command} did not start listening on ${config.upstream.host} within ${String(START_TIMEOUT_MS / 1000)}s.` }
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
    upstream.once('error', (error: Error) => sendOffline(response, config, error.message))
    request.pipe(upstream)
  }

  const server: Server = createServer((request, response) => {
    void ensureUpstream().then((state) => {
      if (!state.ok) {
        sendOffline(response, config, state.detail)
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

  const ready = new Promise<void>((resolve, reject) => {
    server.once('error', (error: Error) => reject(new Error(`dsh-pgadmin: cannot bind ${selfOrigin}: ${error.message}`)))
    server.listen(config.port, config.host, () => {
      const address = server.address()
      if (typeof address === 'object' && address !== null) {
        selfOrigin = `http://${config.host}:${String(address.port)}`
      }
      resolve()
    })
  })

  return {
    get url(): string {
      return selfOrigin
    },
    ready,
    close(): void {
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
 * Start the sidebar proxy and stop it with the plugin fiber.
 * @param ctx - Host plugin context.
 * @param config - the plugin entry's configuration.
 */
export async function apply(ctx: HostContext, config: PgAdminConfig = {}): Promise<void> {
  const proxy = createPgAdminProxy(config)
  ctx.effect(() => () => proxy.close(), 'dsh-pgadmin: proxy')
  await proxy.ready
  console.log(`[dsh-pgadmin] proxying ${String(config.upstream ?? 'http://127.0.0.1:5050')} at ${proxy.url}`)
}
