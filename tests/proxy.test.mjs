/**
 * Behaviour of the loopback proxy, against a stand-in upstream that answers
 * the way pgAdmin does (X-Frame-Options, an absolute redirect, a CSP) — plus
 * the process side: a pgAdmin this proxy started is stopped with it, and one
 * it merely found is left alone.
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createPgAdminProxy } from '../lib/index.js'

/**
 * Bind port 0 to learn a free port, then release it.
 * @returns a port nothing listens on right now.
 */
async function freePort() {
  const probe = createServer()
  probe.listen(0, '127.0.0.1')
  await once(probe, 'listening')
  const { port } = probe.address()
  await new Promise(resolve => probe.close(resolve))
  return port
}

/** Start the stand-in upstream and return its origin and closer. */
async function startUpstream() {
  const server = createServer((request, response) => {
    if (request.url?.startsWith('/redirect')) {
      response.writeHead(302, { location: `http://127.0.0.1:${String(server.address().port)}/after` })
      response.end()
      return
    }
    if (request.url?.startsWith('/echo')) {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(request.headers))
      return
    }
    response.writeHead(200, {
      'content-type': 'text/html',
      'x-frame-options': 'SAMEORIGIN',
      'content-security-policy': "default-src 'self';",
      'set-cookie': 'pga4_session=abc; Path=/; HttpOnly; SameSite=Lax',
    })
    response.end('<h1>pgAdmin</h1>')
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return { origin: `http://127.0.0.1:${String(server.address().port)}`, close: () => server.close() }
}

/**
 * Write a stand-in pgAdmin: a Node script that serves one line on its port.
 * @param {number} port - the port the child answers on.
 * @returns {Promise<string>} the script path.
 */
async function standInServer(port) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-pgadmin-'))
  const script = join(directory, 'server.mjs')
  await writeFile(script, `import { createServer } from 'node:http'
const server = createServer((request, response) => {
  response.writeHead(200, { 'content-type': 'text/plain', 'x-frame-options': 'SAMEORIGIN' })
  response.end('spawned')
})
server.listen(Number(process.argv[2]), '127.0.0.1')
`)
  return script
}

/**
 * Poll a port until it refuses connections.
 * @param {number} port - the port to watch.
 * @returns {Promise<boolean>} whether it stopped listening.
 */
async function stoppedListening(port) {
  const { connect } = await import('node:net')
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const listening = await new Promise((resolve) => {
      const socket = connect({ host: '127.0.0.1', port })
      socket.once('connect', () => { socket.destroy(); resolve(true) })
      socket.once('error', () => resolve(false))
      socket.setTimeout(300, () => { socket.destroy(); resolve(false) })
    })
    if (!listening) return true
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  return false
}

test('forwards the body and drops X-Frame-Options', async () => {
  const upstream = await startUpstream()
  const proxy = createPgAdminProxy({ upstream: upstream.origin, port: 0 })
  await proxy.ready
  try {
    const response = await fetch(`${proxy.url}/browser/`)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('x-frame-options'), null)
    assert.equal(await response.text(), '<h1>pgAdmin</h1>')
    assert.match(response.headers.get('set-cookie') ?? '', /pga4_session=abc/)
  } finally {
    proxy.close()
    upstream.close()
  }
})

test('presents the upstream origin on forwarded requests', async () => {
  const upstream = await startUpstream()
  const proxy = createPgAdminProxy({ upstream: upstream.origin, port: 0 })
  await proxy.ready
  try {
    const response = await fetch(`${proxy.url}/echo`, {
      headers: { origin: proxy.url, referer: `${proxy.url}/login` },
    })
    const headers = await response.json()
    assert.equal(headers.host, upstream.origin.slice('http://'.length))
    assert.equal(headers.origin, upstream.origin)
    assert.equal(headers.referer, `${upstream.origin}/login`)
  } finally {
    proxy.close()
    upstream.close()
  }
})

test('keeps same-upstream redirects on the proxy', async () => {
  const upstream = await startUpstream()
  const proxy = createPgAdminProxy({ upstream: upstream.origin, port: 0 })
  await proxy.ready
  try {
    const response = await fetch(`${proxy.url}/redirect`, { redirect: 'manual' })
    assert.equal(response.status, 302)
    assert.equal(response.headers.get('location'), `${proxy.url}/after`)
  } finally {
    proxy.close()
    upstream.close()
  }
})

test('narrows framing with frame-ancestors when configured', async () => {
  const upstream = await startUpstream()
  const proxy = createPgAdminProxy({
    upstream: upstream.origin,
    port: 0,
    frameAncestors: ['http://127.0.0.1:8080'],
  })
  await proxy.ready
  try {
    const response = await fetch(`${proxy.url}/`)
    assert.equal(response.headers.get('x-frame-options'), null)
    assert.equal(
      response.headers.get('content-security-policy'),
      "default-src 'self'; frame-ancestors http://127.0.0.1:8080",
    )
  } finally {
    proxy.close()
    upstream.close()
  }
})

test('explains itself when nothing is listening and autostart is off', async () => {
  const port = await freePort()
  const proxy = createPgAdminProxy({ upstream: `http://127.0.0.1:${String(port)}`, port: 0, autostart: false })
  await proxy.ready
  try {
    const response = await fetch(`${proxy.url}/`)
    assert.equal(response.status, 502)
    assert.match(await response.text(), /config\.autostart is off/)
  } finally {
    proxy.close()
  }
})

test('starts pgAdmin when nothing answers, and stops it on close', async () => {
  const port = await freePort()
  const script = await standInServer(port)
  const proxy = createPgAdminProxy({
    upstream: `http://127.0.0.1:${String(port)}`,
    port: 0,
    command: process.execPath,
    commandArgs: [script, String(port)],
  })
  await proxy.ready
  try {
    const response = await fetch(`${proxy.url}/`)
    assert.equal(response.status, 200)
    assert.equal(await response.text(), 'spawned')
    assert.equal(response.headers.get('x-frame-options'), null)
  } finally {
    proxy.close()
  }
  assert.equal(await stoppedListening(port), true)
})

test('leaves a pgAdmin it found running when it closes', async () => {
  const upstream = await startUpstream()
  const proxy = createPgAdminProxy({ upstream: upstream.origin, port: 0 })
  await proxy.ready
  await fetch(`${proxy.url}/`)
  proxy.close()
  try {
    const response = await fetch(`${upstream.origin}/`)
    assert.equal(response.status, 200)
  } finally {
    upstream.close()
  }
})

test('rejects a non-http upstream at construction', () => {
  assert.throws(() => createPgAdminProxy({ upstream: 'file:///etc/passwd' }), /must be an http\(s\) URL/)
})
