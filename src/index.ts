/**
 * Host half of `dsh-pgadmin`.
 *
 * The plugin owns no process and opens no socket: you start pgAdmin 4 the way
 * you always do, and the browser half frames the address you configured. The
 * only server-side setting this needs lives in pgAdmin, not here — its
 * `X-Frame-Options: SAMEORIGIN` header (default) has to be turned off in
 * `config_local.py` so a page on another origin may embed it:
 *
 *   X_FRAME_OPTIONS = ""
 *
 * The Host entry exists so the profile can mount the package and the client
 * module graph can serve its bundle.
 */

/** No host-side behavior. @param _ctx - Host plugin context (unused). */
export function apply(_ctx?: unknown): void {}
