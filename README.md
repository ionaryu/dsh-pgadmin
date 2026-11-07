# dsh-pgadmin

## Summary

pgAdmin 4 in the DeepSeek Harness right sidebar, beside the conversation you are working in: browse the schema, open the query tool, watch a slow query while the agent explains it — without a second window covering the chat.

That is not possible with a plain `iframe`, and not because of the sidebar. pgAdmin answers every response with:

```
X-Frame-Options: SAMEORIGIN
```

DSH serves the GUI from one origin (by default `http://127.0.0.1:8080`) and pgAdmin from another (`http://127.0.0.1:5050`), so the browser refuses the frame before pgAdmin renders anything. This plugin ships a loopback proxy in front of pgAdmin that forwards requests unchanged and removes that one header.

## How it works

```
sidebar iframe ──▶ 127.0.0.1:5051 (this plugin)  ──▶ 127.0.0.1:5050 (pgAdmin 4)
                    drops X-Frame-Options
                    keeps cookies, CSP, streaming and redirects
```

- The **Host half** starts the proxy with the plugin, rewrites `Host`, `Origin` and `Referer` the way a direct visit would, and stops the proxy when the plugin unloads.
- The **browser half** registers a page type in DSH's right Sidebar: a guide capsule in the `+` menu, the `pgadmin.open` command, and the body that frames the proxy.
- When nothing answers upstream, the frame shows an explanation with the command that starts pgAdmin instead of an empty panel.
- The pgAdmin session is untouched: its own login, its own cookies, its own server tree. The plugin stores nothing and adds no authentication.

## Requirements

- pgAdmin 4 in web/desktop mode listening on `http://127.0.0.1:5050`. Point `upstream` elsewhere if yours differs.
- The GUI must be opened through the **same host spelling** as the `host` setting: `127.0.0.1` and `localhost` are different sites to a browser, and pgAdmin's `pga4_session` cookie is `SameSite=Lax`, so mixing the two makes the frame reload the login page forever.

## Install

```sh
dsh plugin --profile web add github:ionaryu/dsh-pgadmin
```

The repository commits its built `lib/`, so the install needs no build step and no `allowBuilds` entry. From a local checkout:

```sh
dsh plugin --profile web add file:/E:/dsh-plugins/dsh-pgadmin
```

Restart the harness (or the `dsh web` process) afterwards: the Host half binds the proxy at boot. The tab then appears as a **pgAdmin** capsule in the right sidebar's `+` menu.

## Configuration

Every key is optional. Set them on the plugin row in the profile's `cordis.patch.yml`:

```yaml
- id: pgadmin
  name: dsh-pgadmin
  config:
    upstream: http://127.0.0.1:5050   # pgAdmin web server
    host: 127.0.0.1                   # loopback interface the proxy binds
    port: 5051                        # port the sidebar frames
    autostart: false                  # spawn `command` when upstream is down
    command: pgadmin4                 # command used by autostart
    commandArgs: []                   # arguments for that command
    frameAncestors: []                # extra CSP sources that may frame pgAdmin
    url: http://127.0.0.1:5051        # frame this URL instead of host:port
```

`autostart: true` launches the command once, when the first frame arrives and nothing listens upstream, and then waits up to 20 seconds for it. The process is detached: closing DSH leaves pgAdmin running.

## Security notes

- The proxy binds `127.0.0.1` and adds no authentication. It exposes exactly what pgAdmin already exposes to this machine — nothing more, nothing less.
- Removing `X-Frame-Options` means any page on this machine could frame pgAdmin *through this proxy*; pgAdmin's own login and CSRF tokens still apply. To narrow framing to the GUI, set `frameAncestors: ['http://127.0.0.1:8080']` — the proxy appends that directive to pgAdmin's CSP.
- The framed page runs with `allow-scripts allow-forms allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-downloads allow-modals`. Downloads and modals are needed by the query tool's export and confirmation dialogs; drop them from `src/client/index.tsx` if your policy forbids them.
- If the GUI is served over HTTPS, a plain-HTTP frame is blocked as mixed content. Terminate TLS in front of the proxy and set `url` and `upstream` accordingly.

## Troubleshooting

| Symptom | Cause |
|:--|:--|
| "pgAdmin 4 is not reachable" inside the panel | Nothing is listening on `upstream`; start pgAdmin or set `autostart: true`. |
| Login page returns after every sign-in | Different host spellings for the GUI and `host` (see Requirements). |
| Panel stays empty | The plugin failed to bind; the harness log has `dsh-pgadmin: cannot bind` with the port. |
| `autostart` does nothing | `command` is not on the PATH the harness was started with; give an absolute path. |

## Development

```sh
pnpm install
pnpm build     # lib/index.js and lib/client.js
pnpm test      # proxy behaviour + the browser half's registrations
```

`lib/` is committed on purpose, so `dsh plugin add` installs a runnable package.

## License

MIT
