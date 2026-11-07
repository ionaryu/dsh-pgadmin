/**
 * Behaviour of the loopback proxy, against a stand-in upstream that answers
 * the way pgAdmin does (X-Frame-Options, an absolute redirect, a CSP).
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import test from 'node:test'
import { createPgAdminProxy } from '../lib/index.js'

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

test('serves an explanation when pgAdmin is not listening', async () => {
  const upstream = await startUpstream()
  const dead = upstream.origin
  upstream.close()
  const proxy = createPgAdminProxy({ upstream: dead, port: 0 })
  await proxy.ready
  try {
    const response = await fetch(`${proxy.url}/`)
    assert.equal(response.status, 502)
    const page = await response.text()
    assert.match(page, /pgAdmin 4 is not reachable/)
    assert.match(page, /config\.autostart/)
  } finally {
    proxy.close()
  }
})

test('rejects a non-http upstream at construction', () => {
  assert.throws(() => createPgAdminProxy({ upstream: 'file:///etc/passwd' }), /must be an http\(s\) URL/)
})
