# dsh-pgadmin

## Summary

pgAdmin 4 in the DeepSeek Harness right sidebar, beside the conversation you are working in. You do not start pgAdmin, and you do not configure it: open the panel and the plugin brings it up.

## How it works

Two pieces, both owned by the plugin's Host half:

```
sidebar iframe ──▶ 127.0.0.1:5051 (in-process proxy) ──▶ 127.0.0.1:5050 (pgAdmin 4)
                    drops X-Frame-Options                started on first use,
                    keeps cookies, CSP, redirects        stopped with the plugin
```

- **The process.** The first request starts `pgadmin4` (unless one is already listening), waits for it, and stops the process it started when the plugin unloads. A pgAdmin that was already running is used but never killed.
- **The frame.** pgAdmin answers every response with `X-Frame-Options: SAMEORIGIN`, which no page on another origin may embed. The proxy forwards requests unchanged and removes that one header, so no pgAdmin configuration has to change.
- The browser half registers one right-Sidebar page: a **pgAdmin** capsule in the `+` menu, the `pgadmin.open` command, and a toolbar with **Start**, **Stop**, Reload and Open in browser. Start and Stop drive the Host half through `/__dsh-pgadmin/start` and `/__dsh-pgadmin/stop` on the proxy, so the panel owns the process without leaving the page.
- While pgAdmin starts, the panel waits on the proxy; if it cannot start, the panel shows the reason and the captured stderr instead of a blank frame.

## Requirements

- pgAdmin 4 installed so that `pgadmin4` runs from the harness's `PATH`. A pip install qualifies; if it lives elsewhere, set `command` to its absolute path.
- The GUI opened through the same host spelling as the proxy (`127.0.0.1` vs `localhost` are different sites to a browser, and pgAdmin's `pga4_session` cookie is `SameSite=Lax`).

## Install

```sh
dsh plugin --profile web add github:ionaryu/dsh-pgadmin
```

The repository commits its built `lib/`, so the install needs no build step. The capsule appears in the right sidebar's `+` menu.

## Configuration

Every key is optional; the defaults are shown.

```yaml
- id: pgadmin
  name: dsh-pgadmin
  config:
    upstream: http://127.0.0.1:5050   # pgAdmin web server
    host: 127.0.0.1                   # loopback interface the proxy binds
    port: 5051                        # port the sidebar frames
    autostart: true                   # start pgAdmin when nothing answers
    command: pgadmin4                 # command used to start it
    commandArgs: []                   # arguments for that command
    setupEmail: ''                    # first-run account (see below)
    setupPassword: ''                 # first-run account password
    frameAncestors: []                # extra CSP sources allowed to frame it
    url: http://127.0.0.1:5051        # frame this URL instead of host:port
```

`autostart: false` uses only a pgAdmin you run yourself; the panel then reports that nothing is listening instead of starting one.

`setupEmail` and `setupPassword` are read only when pgAdmin's database has no user yet: they become `PGADMIN_SETUP_EMAIL` / `PGADMIN_SETUP_PASSWORD` for the child, which turns pgAdmin's interactive first-run prompt into account creation. Without them, a missing database makes pgAdmin fail with `EOFError` (its prompt has no stdin), and the panel says so. Remove both values once the account exists — they are inert from then on.

## Security notes

- The proxy binds `127.0.0.1`, adds no authentication, and exposes exactly what pgAdmin already exposes to this machine.
- Removing `X-Frame-Options` means any page on this machine could frame pgAdmin through the proxy; pgAdmin's own login and CSRF tokens still apply. Set `frameAncestors: ['http://127.0.0.1:8080']` to narrow framing to the GUI — the proxy appends that directive to pgAdmin's CSP.
- The framed page runs with `allow-scripts allow-forms allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-downloads allow-modals`. Drop the last two in `src/client/index.tsx` if your policy forbids downloads or dialogs.

## Troubleshooting

| Symptom | Cause |
|:--|:--|
| "pgAdmin 4 did not start" in the panel | `pgadmin4` is not on `PATH`; the page shows its stderr — set `command` to an absolute path. |
| The stderr ends in `EOFError` | pgAdmin's database has no user and pgAdmin tried to prompt: set `setupEmail` and `setupPassword`. |
| "pgAdmin 4 is not reachable" with autostart off | Nothing listens upstream and the plugin was told not to start one. |
| Login page returns after every sign-in | Different host spellings for the GUI and the proxy (see Requirements). |
| `dsh-pgadmin: cannot bind` in the harness log | The proxy port is taken; change `port` (and `url` to match). |

## Development

```sh
pnpm install
pnpm build     # lib/index.js and lib/client.js
pnpm test      # proxy, process ownership, and the browser half's registrations
```

`lib/` is committed on purpose, so `dsh plugin add` installs a runnable package.

## License

MIT
