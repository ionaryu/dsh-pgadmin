/**
 * Client half of `dsh-pgadmin`: one right-Sidebar page that shows pgAdmin 4.
 *
 * The page frames the loopback proxy this package's Host half runs. The Host
 * half also starts pgAdmin 4 on first use and stops it on unload, so the panel
 * works without the user launching a server — the proxy exists only because
 * pgAdmin's `X-Frame-Options: SAMEORIGIN` would otherwise keep the frame from
 * rendering at all.
 */

import { useState } from 'react'

/** Plugin name. */
export const name = 'dsh-pgadmin'

/** Services this plugin needs; `shortcuts` is taken opportunistically. */
export const inject = ['slots', 'locale', 'sidebarRight', 'sidebarRightTabs']

/** This package's identity in the tab system and the key its body registers under. */
const PAGE_ID = 'dsh-pgadmin'

/** Tab kind the guide capsule and `openTab` name. */
const PAGE_KIND = 'pgadmin'

/** Locale namespace owned by this plugin. */
const NS = 'dsh-pgadmin'

/** Command id the guide capsule shows and the keyboard runs. */
const OPEN_COMMAND = 'pgadmin.open'

/** pgAdmin's proxy port; the page frames it unless configured otherwise. */
const DEFAULT_PORT = 5051

/** Configuration, mirroring the Host half's entry config. */
export interface SidebarConfig {
  /** Port the Host half's proxy listens on. Default `5051`. */
  readonly port?: number
  /** Complete URL to frame instead of `http://<gui host>:<port>`. */
  readonly url?: string
}

/** One localized dictionary; keys mirror the English source of truth. */
interface Dictionary {
  /** Tab and guide title. */
  title: string
  /** Guide capsule description. */
  guide: string
  /** Reload the framed page. */
  reload: string
  /** Open the same address in the system browser. */
  open: string
  /** Accessible name of the framed region. */
  frame: string
}

const EN: Dictionary = {
  title: 'pgAdmin',
  guide: 'Start pgAdmin 4 and show it in this panel.',
  reload: 'Reload',
  open: 'Open in browser',
  frame: 'pgAdmin 4',
}

const DICTIONARIES: Record<string, Dictionary> = {
  en: EN,
  ko: {
    title: 'pgAdmin',
    guide: 'pgAdmin 4를 켜서 이 패널에 띄웁니다.',
    reload: '새로고침',
    open: '브라우저로 열기',
    frame: 'pgAdmin 4',
  },
  ja: {
    title: 'pgAdmin',
    guide: 'pgAdmin 4 を起動してこのパネルに表示します。',
    reload: '再読み込み',
    open: 'ブラウザで開く',
    frame: 'pgAdmin 4',
  },
  zh: {
    title: 'pgAdmin',
    guide: '启动 pgAdmin 4 并在此面板中显示。',
    reload: '重新加载',
    open: '在浏览器中打开',
    frame: 'pgAdmin 4',
  },
}

/** The slice of the client context this plugin uses. */
interface ClientContext {
  get(name: string): unknown
  effect(execute: () => (() => void) | void, label?: string): unknown
  inject(names: string[], callback: (scope: ClientContext) => void): void
  readonly locale: {
    register(namespace: string, dictionaries: Record<string, Record<string, string>>): () => void
    bind(namespace: string): (key: string) => string
  }
  readonly slots: {
    register(registration: { name: string; key: string }, component: () => unknown): () => void
    inject(name: string, contribute: () => () => void): () => void
  }
  readonly sidebarRightTabs: {
    register(definition: Record<string, unknown>): () => void
  }
  readonly sidebarRight: {
    commandTarget(element: Element | undefined): unknown
    openTabFromTarget(kind: string, target: unknown): void
  }
  readonly shortcuts?: {
    register(command: Record<string, unknown>): () => void
  }
}

/**
 * Frame address: the configured override, else the Host half's proxy on the
 * GUI's own host — the same host keeps pgAdmin's `SameSite=Lax` session cookie
 * same-site, which it needs to stay logged in inside a frame.
 * @param config - the entry configuration.
 * @returns the URL the page frames.
 */
function frameUrl(config: SidebarConfig): string {
  if (typeof config.url === 'string' && config.url !== '') return config.url
  const port = Number(config.port ?? DEFAULT_PORT)
  const host = typeof window === 'undefined' ? '127.0.0.1' : window.location.hostname
  return `http://${host}:${String(port)}`
}

/** The guide's database glyph, drawn on the product icon grid. */
function PgAdminIcon({ size = 16, className }: { size?: number; className?: string }): unknown {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.15"
      strokeLinecap="round"
      className={className}
      aria-hidden="true"
    >
      <ellipse cx="8" cy="3.5" rx="5.1" ry="2" />
      <path d="M2.9 3.5v9c0 1.1 2.28 2 5.1 2s5.1-.9 5.1-2v-9" />
      <path d="M2.9 8c0 1.1 2.28 2 5.1 2s5.1-.9 5.1-2" />
    </svg>
  )
}

/** A toolbar control: quiet, 22px tall, readable next to pgAdmin's chrome. */
const buttonStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  height: 22,
  padding: '0 8px',
  border: '1px solid var(--dsw-alias-border-subtle, rgba(127,127,127,.28))',
  borderRadius: 5,
  background: 'transparent',
  color: 'var(--dsw-alias-label-secondary, inherit)',
  font: 'inherit',
  fontSize: 11,
  cursor: 'pointer',
  flex: 'none',
} as const

/** What one framed page needs from the registered body. */
interface PageProps {
  /** URL to frame. */
  url: string
  /** Translate one dictionary key. */
  t: (key: keyof Dictionary) => string
}

/**
 * The page itself: a toolbar over the framed pgAdmin session.
 * @param props - the frame address and the translate function.
 * @returns the rendered page.
 */
function PgAdminPage({ url, t }: PageProps): unknown {
  const [generation, setGeneration] = useState(0)
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '4px 8px',
          borderBottom: '1px solid var(--dsw-alias-border-subtle, rgba(127,127,127,.22))',
        }}
      >
        <span
          style={{
            flex: 1,
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            fontSize: 11,
            color: 'var(--dsw-alias-label-tertiary, inherit)',
          }}
        >
          {url}
        </span>
        <button type="button" style={buttonStyle} onClick={() => setGeneration(value => value + 1)}>
          {t('reload')}
        </button>
        <button type="button" style={buttonStyle} onClick={() => window.open(url, '_blank', 'noopener,noreferrer')}>
          {t('open')}
        </button>
      </div>
      <iframe
        key={generation}
        src={url}
        title={t('frame')}
        sandbox="allow-scripts allow-forms allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-downloads allow-modals"
        style={{ flex: 1, width: '100%', minHeight: 0, border: 0, background: '#fff' }}
      />
    </div>
  )
}

/**
 * Register the pgAdmin page, its guide capsule, and its command.
 * @param ctx - client plugin context.
 * @param config - the entry configuration.
 */
export function apply(ctx: ClientContext, config: SidebarConfig = {}): void {
  ctx.effect(() => ctx.locale.register(NS, { en: { ...EN }, ...DICTIONARIES }), 'dsh-pgadmin: copy')
  const bound = ctx.locale.bind(NS)
  const t = (key: keyof Dictionary): string => bound(key)
  const url = frameUrl(config)

  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: PAGE_ID,
    kind: PAGE_KIND,
    keepMounted: true,
    title: () => t('title'),
    guide: [{
      id: 'open',
      commandId: OPEN_COMMAND,
      order: 40,
      title: () => t('title'),
      description: () => t('guide'),
      icon: PgAdminIcon,
    }],
  }), 'dsh-pgadmin: page type')

  const Body = (): unknown => PgAdminPage({ url, t })
  ctx.effect(
    () => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({ name: 'sidebar.right.pane.tab', key: PAGE_ID }, Body)),
    'dsh-pgadmin: page body',
  )

  ctx.inject(['shortcuts'], (scope) => {
    const shortcuts = scope.get('shortcuts') as ClientContext['shortcuts'] | undefined
    if (shortcuts === undefined) return
    scope.effect(() => shortcuts.register({
      id: OPEN_COMMAND,
      label: () => t('title'),
      aliases: ['pgadmin', 'postgres', 'database'],
      regions: ['page', 'editable', 'terminal'],
      modals: [],
      resolve: ({ target }: { target?: Element }) => {
        const destination = scope.sidebarRight.commandTarget(target)
        if (destination === undefined) return { status: 'blocked', reason: t('guide') }
        return { status: 'handled', run: () => { scope.sidebarRight.openTabFromTarget(PAGE_KIND, destination) } }
      },
    }), 'dsh-pgadmin: command')
  })
}

