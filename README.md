# dsh-pgadmin

## Summary

Shows the pgAdmin 4 you are already running inside the DeepSeek Harness right sidebar, beside the conversation you are working in.

The plugin starts nothing and proxies nothing. It adds one right-Sidebar page — a **pgAdmin** capsule in the `+` menu, the `pgadmin.open` command, and a framed view of `http://127.0.0.1:5050` with a reload and an open-in-browser control.

## Why one pgAdmin line is needed

pgAdmin answers every response with:

```
X-Frame-Options: SAMEORIGIN
```

DSH serves the GUI from one origin (`:8080`) and pgAdmin from another (`:5050`), so the browser refuses the frame before pgAdmin renders anything. The header is a pgAdmin configuration value, so turn it off there — not in this plugin:

```python
# config_local.py, next to pgAdmin's config.py
X_FRAME_OPTIONS = ""
```

`pgadmin/utils/security_headers.py` skips the header when that value is empty, and `pgadmin/evaluate_config.py` loads `config_local.py` from the Python path. For a pip install that file lives here:

```
C:\Users\<you>\AppData\Local\Programs\Python\<version>\Lib\site-packages\pgadmin4\config_local.py
```

Restart pgAdmin afterwards. Any page on this machine can then frame it, which is the tradeoff of that line; pgAdmin's own login and CSRF tokens still apply.

## Requirements

- pgAdmin 4 running and reachable at the configured address. Start it however you normally do.
- The GUI opened through the same host spelling as the framed address (`127.0.0.1` vs `localhost` are different sites to a browser, and pgAdmin's `pga4_session` cookie is `SameSite=Lax`).

## Install

```sh
dsh plugin --profile web add github:ionaryu/dsh-pgadmin
```

The repository commits its built `lib/`, so the install needs no build step. The capsule appears in the right sidebar's `+` menu; no restart is needed if the profile reloads patches live.

## Configuration

```yaml
- id: pgadmin
  name: dsh-pgadmin
  config:
    url: http://127.0.0.1:5050   # default
```

Point `url` at another host or port when pgAdmin listens elsewhere.

## Development

```sh
pnpm install
pnpm build     # lib/index.js and lib/client.js
pnpm test      # the browser half's registrations
```

`lib/` is committed on purpose, so `dsh plugin add` installs a runnable package.

## License

MIT
