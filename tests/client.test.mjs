/**
 * The browser half's registration, executed the way the client module system
 * executes it: the bundle calls `window.__ModuleLoader__.load({ id, factory })`
 * and the factory receives the shared module table's `require`.
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

/** Load the built bundle and return the plugin exports it registers. */
async function loadPlugin() {
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  let row
  const sandbox = {
    console,
    window: {
      location: { hostname: '127.0.0.1' },
      __ModuleLoader__: { load: (registered) => { row = registered } },
    },
  }
  vm.runInNewContext(source, sandbox)
  assert.equal(row.id, 'dsh-pgadmin')
  const react = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: (initial) => [initial, () => {}],
  }
  const jsx = {
    jsx: (type, props) => ({ type, props }),
    jsxs: (type, props) => ({ type, props }),
    Fragment: 'Fragment',
  }
  return row.factory(specifier => (specifier === 'react' ? react : jsx))
}

/** A context that records every contribution the plugin makes. */
function createContext() {
  const calls = { tabs: [], slotsInject: [], slots: [], shortcuts: [], opened: [], registered: [] }
  const shortcuts = {
    register: (command) => {
      calls.shortcuts.push(command)
      return () => {}
    },
  }
  const ctx = {
    effect: (execute) => execute(),
    get: (name) => (name === 'shortcuts' ? shortcuts : undefined),
    inject: (names, callback) => { if (names.includes('shortcuts')) callback(ctx) },
    locale: {
      register: (namespace, dictionaries) => {
        calls.registered.push({ namespace, dictionaries })
        return () => {}
      },
      bind: () => (key) => `T:${key}`,
    },
    slots: {
      register: (registration, component) => {
        calls.slots.push({ registration, component })
        return () => {}
      },
      inject: (name, contribute) => {
        calls.slotsInject.push(name)
        contribute()
        return () => {}
      },
    },
    sidebarRightTabs: {
      register: (definition) => {
        calls.tabs.push(definition)
        return () => {}
      },
    },
    sidebarRight: {
      commandTarget: () => ({ pane: 'main', session: 's1' }),
      openTabFromTarget: (kind, target) => calls.opened.push({ kind, target }),
    },
  }
  return { ctx, calls }
}

test('registers one layered page: guide capsule, body seat, and command', async () => {
  const plugin = await loadPlugin()
  assert.equal(plugin.name, 'dsh-pgadmin')
  const { ctx, calls } = createContext()
  plugin.apply(ctx, {})

  assert.equal(calls.registered.length, 1)
  assert.equal(calls.registered[0].namespace, 'dsh-pgadmin')
  assert.ok(Object.keys(calls.registered[0].dictionaries).includes('ko'))

  const [page] = calls.tabs
  assert.equal(page.id, 'dsh-pgadmin')
  assert.equal(page.kind, 'pgadmin')
  assert.equal(page.title(), 'T:title')
  assert.equal(page.guide[0].commandId, 'pgadmin.open')
  assert.equal(page.guide[0].title(), 'T:title')
  assert.equal(typeof page.guide[0].icon, 'function')

  assert.deepEqual(calls.slotsInject, ['sidebar.right.pane.tab'])
  const [{ registration, component }] = calls.slots
  assert.equal(registration.key, 'dsh-pgadmin')
  const view = component()
  assert.equal(view.type, 'div')
  const iframe = view.props.children[1]
  assert.equal(iframe.type, 'iframe')
  assert.equal(iframe.props.src, 'http://127.0.0.1:5050')
  assert.match(iframe.props.sandbox, /allow-same-origin/)
  assert.match(iframe.props.sandbox, /allow-forms/)
})

test('the command opens the page for the target it ran from', async () => {
  const plugin = await loadPlugin()
  const { ctx, calls } = createContext()
  plugin.apply(ctx, {})

  const [command] = calls.shortcuts
  assert.equal(command.id, 'pgadmin.open')
  const handled = command.resolve({ target: {} })
  assert.equal(handled.status, 'handled')
  handled.run()
  assert.equal(calls.opened[0].kind, 'pgadmin')

  ctx.sidebarRight.commandTarget = () => undefined
  const blocked = command.resolve({ target: {} })
  assert.equal(blocked.status, 'blocked')
  assert.equal(blocked.reason, 'T:guide')
})

test('an explicit url config is framed verbatim', async () => {
  const plugin = await loadPlugin()
  const { ctx, calls } = createContext()
  plugin.apply(ctx, { url: 'https://pgadmin.example.com/' })
  const view = calls.slots[0].component()
  assert.equal(view.props.children[1].props.src, 'https://pgadmin.example.com/')
})
