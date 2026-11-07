/**
 * Build both faces of the plugin.
 *
 * - `lib/index.js`  — the Host entry (ESM, Node built-ins only).
 * - `lib/client.js` — the browser entry, wrapped in the client module system's
 *   registration protocol: `window.__ModuleLoader__.load({ id, factory })`,
 *   where the factory returns the Cordis plugin exports (`name`, `apply`).
 *
 * React and its automatic JSX runtime are not bundled: the shell already seeds
 * both into the module table, so the factory's `require` resolves them and the
 * page shares the application's React instance.
 */
import { build } from 'esbuild'
import { mkdir, readFile, writeFile } from 'node:fs/promises'

const manifest = JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8'))

await build({
  entryPoints: ['src/index.ts'],
  outfile: 'lib/index.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  legalComments: 'none',
})

const client = await build({
  entryPoints: ['src/client/index.tsx'],
  bundle: true,
  write: false,
  platform: 'browser',
  format: 'cjs',
  target: 'es2022',
  jsx: 'automatic',
  external: ['react', 'react/jsx-runtime'],
  legalComments: 'none',
})

const body = client.outputFiles[0].text
  .split('\n')
  .map(line => (line === '' ? line : `\t\t${line}`))
  .join('\n')

const bundle = `window.__ModuleLoader__.load({
\tid: ${JSON.stringify(manifest.name)},
\tfactory: (require) => {
\t\tvar module = { exports: {} }
\t\tvar exports = module.exports
${body}
\t\treturn module.exports
\t}
})
`

await mkdir('lib', { recursive: true })
await writeFile('lib/client.js', bundle)
console.log('built lib/index.js and lib/client.js')
