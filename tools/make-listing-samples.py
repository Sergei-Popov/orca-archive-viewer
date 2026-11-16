#!/usr/bin/env python3
"""Builds the demo archives for Archive Viewer's listing images into .orca/listing/samples/.

    python3 tools/make-listing-samples.py [--jar PATH] [--png PATH] [--out DIR]

Writes three files, all made up here except two shared demo assets:

- aurora-web-3.2.0.zip: a fictional sky-watching web app, 1,856 files dated 2026-11-03:
  TypeScript from templates, docs, locales, public/images/hero.png (a 1600 x 640 banner cut
  from sunset.png), a vendored jar and a .tgz.
- aurora-web-3.2.0.tar.xz: the same tree, written by Python's tarfile ('w:xz', CRC64 check).
- projects-2019.zip: Russian names stored in code page 866 without the UTF-8 flag, as Windows
  Explorer writes them, and Windows-1251 text inside.

Shared assets, read-only, from the sibling plugins in the hub (or given as arguments):
- observatory-2.0.0.jar (real class bytes): plugins/class-viewer/.orca/listing/samples/, built by
  class-viewer's tools/make-listing-samples.sh. Its MANIFEST.MF loses the JDK vendor here.
- sunset.png (CC0, rendered): plugins/image-viewer/.orca/listing/samples/ or .samples/demo/,
  built by image-viewer's tools/listing-samples.sh.

Every name, host and text is fictional (example.com and .test hosts, TEST-NET addresses).
Standard library only; the output is the same on every run.
"""

from __future__ import annotations

import argparse
import gzip
import io
import json
import random
import struct
import sys
import tarfile
import zipfile
import zlib
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

PLUGIN = Path(__file__).resolve().parent.parent
PLUGINS = PLUGIN.parent
TOP = 'aurora-web-3.2.0'
DAY = (2026, 11, 3)

JAR_CANDIDATES = [PLUGINS / 'class-viewer/.orca/listing/samples/observatory-2.0.0.jar']
PNG_CANDIDATES = [
    PLUGINS / 'image-viewer/.orca/listing/samples/sunset.png',
    PLUGINS / 'image-viewer/.samples/demo/sunset.png',
]

rng = random.Random(20261103)


# ---------------------------------------------------------------------------------------------
# Names


def pascal(words: str) -> str:
    return ''.join(part[:1].upper() + part[1:] for part in words.replace('-', ' ').split())


def camel(words: str) -> str:
    name = pascal(words)
    return name[:1].lower() + name[1:]


def kebab(words: str) -> str:
    return '-'.join(words.lower().split())


FEATURES = {
    'alerts': 'alert',
    'bookings': 'booking',
    'cameras': 'camera',
    'clouds': 'cloud layer',
    'community': 'post',
    'dashboard': 'widget',
    'events': 'event',
    'forecast': 'forecast',
    'gallery': 'photo',
    'glossary': 'term',
    'kp-index': 'kp reading',
    'locations': 'location',
    'maps': 'map layer',
    'moon': 'moon phase',
    'notifications': 'notification',
    'observatories': 'observatory',
    'onboarding': 'step',
    'profile': 'profile',
    'search': 'result',
    'settings': 'setting',
    'sightings': 'sighting',
    'solar-wind': 'solar wind sample',
    'tours': 'tour',
    'weather': 'weather report',
}

COMPONENT_SUFFIXES = [
    'list', 'card', 'detail', 'filters', 'header', 'summary', 'chart', 'form', 'empty state',
    'skeleton', 'toolbar', 'item', 'panel', 'badge', 'table', 'dialog', 'timeline', 'legend',
]

HOOK_SUFFIXES = ['query', 'filters', 'subscription', 'pagination', 'selection', 'sort', 'draft']

SHARED_COMPONENTS = [
    'avatar', 'badge', 'banner', 'button', 'card', 'checkbox', 'chip', 'date picker', 'dialog',
    'divider', 'drawer', 'dropdown', 'empty state', 'error boundary', 'file input', 'footer',
    'header', 'icon', 'icon button', 'image', 'input', 'kbd', 'label', 'link', 'list', 'loader',
    'map view', 'menu', 'meter', 'modal', 'pagination', 'popover', 'progress', 'radio',
    'range slider', 'search box', 'select', 'sheet', 'skeleton', 'spinner', 'stack', 'stat',
    'switch', 'table', 'tabs', 'tag', 'text area', 'timeline', 'toast', 'toolbar', 'tooltip',
    'visually hidden',
]

LIB_AREAS = {
    'http': ['client', 'errors', 'retry', 'headers', 'query string', 'timeouts', 'interceptors'],
    'i18n': ['plural', 'format date', 'format number', 'detect locale', 'messages', 'relative time'],
    'storage': ['local store', 'session store', 'migrations', 'keys', 'quota'],
    'time': ['ranges', 'sunrise', 'twilight', 'time zones', 'durations', 'calendar'],
    'units': ['speed', 'distance', 'temperature', 'magnetic field', 'density'],
    'geo': ['coordinates', 'bounds', 'geohash', 'distance', 'projection', 'light pollution'],
    'math': ['clamp', 'interpolate', 'moving average', 'percentile', 'round'],
    'log': ['logger', 'levels', 'sinks', 'redact'],
    'cache': ['memory cache', 'stale while revalidate', 'keys', 'eviction'],
    'auth': ['session', 'tokens', 'guards', 'refresh', 'scopes'],
    'events': ['emitter', 'bus', 'throttle', 'debounce'],
    'routing': ['links', 'params', 'scroll restore', 'prefetch'],
}

SHARED_HOOKS = [
    'media query', 'interval', 'timeout', 'local storage', 'debounced value', 'previous',
    'online status', 'visibility', 'geolocation', 'clipboard', 'hotkeys', 'resize observer',
    'intersection', 'reduced motion', 'color scheme', 'focus trap', 'scroll lock', 'event listener',
    'mounted', 'toggle',
]

UTILS = [
    'array', 'assert', 'bytes', 'class names', 'compare', 'deep equal', 'download', 'escape',
    'format', 'group by', 'hash', 'ids', 'invariant', 'is defined', 'json', 'keys', 'memo',
    'noop', 'object', 'omit', 'once', 'parse', 'pick', 'promise', 'random', 'range', 'sleep',
    'slug', 'sort by', 'strings', 'truncate', 'uniq', 'url',
]

PAGES = [
    'home', 'forecast', 'tonight', 'map', 'sightings', 'sighting', 'report sighting', 'gallery',
    'photo', 'events', 'event', 'tours', 'tour', 'booking', 'observatories', 'observatory',
    'cameras', 'camera', 'alerts', 'settings', 'profile', 'sign in', 'sign up', 'reset password',
    'glossary', 'about', 'privacy', 'terms', 'not found', 'offline', 'status', 'help',
]

LOCALES = ['de', 'en', 'es', 'fi', 'fr', 'is', 'it', 'ja', 'ko', 'nb', 'nl', 'pl', 'pt-BR',
           'ru', 'sv', 'uk', 'zh-CN']

DOCS = [
    'accessibility', 'architecture', 'browser-support', 'caching', 'code-style', 'contributing',
    'data-sources', 'deployment', 'design-tokens', 'error-handling', 'feature-flags',
    'getting-started', 'glossary', 'i18n', 'map-tiles', 'offline-mode', 'performance',
    'release-process', 'routing', 'security', 'state-management', 'testing', 'troubleshooting',
]


# ---------------------------------------------------------------------------------------------
# File templates


def ts_component(name: str, feature: str | None) -> str:
    area = feature or 'shared'
    item = pascal(FEATURES.get(feature or '', 'item'))
    fields = rng.sample(['subtitle', 'compact', 'selected', 'disabled', 'onSelect', 'onClose',
                         'className', 'variant', 'emptyText', 'maxItems'], 3)
    types = {
        'subtitle': 'string', 'compact': 'boolean', 'selected': 'string | null', 'disabled': 'boolean',
        'onSelect': '(id: string) => void', 'onClose': '() => void', 'className': 'string',
        'variant': "'default' | 'muted' | 'accent'", 'emptyText': 'string', 'maxItems': 'number',
    }
    docs = {
        'subtitle': 'A second line under the title.', 'compact': 'Tighter rows for side panels.',
        'selected': 'The id of the highlighted row.', 'disabled': 'Shown but not interactive.',
        'onSelect': 'Called with the id of the row the user picks.', 'onClose': 'Called when the user dismisses it.',
        'className': 'Extra class names for the root element.', 'variant': 'Colour scheme of the frame.',
        'emptyText': 'Replaces the default empty message.', 'maxItems': 'Rows shown before "Show all".',
    }
    lines = [
        "import { useMemo, type ReactNode } from 'react'",
        "import { useMessages } from '../../../lib/i18n/messages'",
        "import { relativeTime } from '../../../lib/i18n/relative-time'",
        f"import type {{ {item} }} from '../../model/types'" if feature else "import type { Item } from '../../types/global'",
        f"import {{ styles }} from './{name}.styles'",
        '',
        f'export type {name}Props = {{',
        '  /** Rows to show, newest first. */',
        f'  items: {item if feature else "Item"}[]',
        '  /** Heading above the rows. */',
        '  title?: string',
        '  /** A skeleton instead of the rows while they load. */',
        '  loading?: boolean',
    ]
    for field in fields:
        lines += [f'  /** {docs[field]} */', f'  {field}?: {types[field]}']
    lines += [
        '  children?: ReactNode',
        '}',
        '',
        'const LABELS = {',
        f"  empty: '{area}.empty',",
        f"  loading: '{area}.loading',",
        f"  count: '{area}.count',",
        '} as const',
        '',
        '/**',
        f' * {name} for the {area} screens: a titled list of {FEATURES.get(feature or "", "item")}s with',
        ' * the time each one changed. It keeps its own layout, so it works in pages and panels alike.',
        ' */',
        f'export function {name}({{ items, title, loading, {", ".join(fields)}, children }}: {name}Props) {{',
        '  const t = useMessages()',
        '  const rows = useMemo(() => newestFirst(items), [items])',
        '',
        '  if (loading) return <div className={styles.skeleton} aria-busy="true" aria-label={t(LABELS.loading)} />',
        '  if (!rows.length) return <p className={styles.empty}>{t(LABELS.empty)}</p>',
        '',
        '  return (',
        f'    <section className={{styles.root}} data-component="{kebab(name)}">',
        '      <header className={styles.header}>',
        '        {title ? <h3 className={styles.title}>{title}</h3> : null}',
        '        <span className={styles.count}>{t(LABELS.count, { count: rows.length })}</span>',
        '      </header>',
        '      <ul className={styles.list}>',
        '        {rows.map((row) => (',
        '          <li key={row.id} className={styles.row}>',
        '            <span className={styles.label}>{row.id}</span>',
        '            <time dateTime={row.updatedAt}>{relativeTime(row.updatedAt)}</time>',
        '          </li>',
        '        ))}',
        '      </ul>',
        '      {children}',
        '    </section>',
        '  )',
        '}',
        '',
        'function newestFirst<T extends { updatedAt: string }>(rows: T[]): T[] {',
        '  return [...rows].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))',
        '}',
        '',
    ]
    for _ in range(rng.randint(0, 3)):
        helper = rng.choice(['label', 'tone', 'width', 'order', 'key', 'summary'])
        lines += [
            f'/** The {helper} of a row, for sorting and test ids. */',
            f'export function row{pascal(helper)}(value: string): string {{',
            "  return value.trim().toLowerCase().replace(/\\s+/g, '-')",
            '}',
            '',
        ]
    return '\n'.join(lines)


def ts_component_test(name: str) -> str:
    cases = rng.sample([
        ('renders its title', 'expect(view.getByRole("heading").text).toBe("Tonight")'),
        ('shows a skeleton while loading', 'expect(view.root.getAttribute("aria-busy")).toBe("true")'),
        ('lists the newest row first', 'expect(view.getAllByRole("listitem")[0].text).toContain("b")'),
        ('shows the empty message', 'expect(view.root.text).toContain("empty")'),
        ('counts the rows', 'expect(view.root.text).toContain("2")'),
        ('keeps focus on the list', 'expect(document.activeElement).toBe(view.root)'),
        ('renders children after the list', 'expect(view.root.lastChild).toBeDefined()'),
        ('marks the times for screen readers', 'expect(view.getAllByRole("time")).toHaveLength(2)'),
    ], rng.randint(3, 6))
    out = [
        "import { describe, expect, it } from '../../../tests/harness'",
        "import { render } from '../../../tests/render'",
        f"import {{ {name} }} from './{name}'",
        '',
        'const items = [',
        "  { id: 'a', createdAt: '2026-10-30T21:04:00Z', updatedAt: '2026-10-30T21:04:00Z' },",
        "  { id: 'b', createdAt: '2026-11-01T22:47:00Z', updatedAt: '2026-11-02T06:12:00Z' },",
        ']',
        '',
        f"describe('{name}', () => {{",
    ]
    for title, check in cases:
        loading = ' loading' if 'loading' in title else ''
        empty = '[]' if 'empty' in title else 'items'
        out += [
            f"  it('{title}', () => {{",
            f'    const view = render(<{name} title="Tonight" items={{{empty}}}{loading} />)',
            f'    {check}',
            '  })',
            '',
        ]
    out[-1] = '})'
    return '\n'.join(out) + '\n'


def ts_styles(name: str) -> str:
    gap = rng.choice([4, 6, 8, 12, 16])
    return '\n'.join([
        "import { css } from '../../../styles/css'",
        "import { tokens } from '../../../styles/tokens'",
        '',
        'export const styles = {',
        f'  root: css({{ display: "flex", flexDirection: "column", gap: {gap}, minWidth: 0 }}),',
        '  header: css({ display: "flex", alignItems: "baseline", justifyContent: "space-between" }),',
        '  title: css({ font: tokens.font.heading, margin: 0 }),',
        '  count: css({ color: tokens.color.muted, fontVariantNumeric: "tabular-nums" }),',
        '  list: css({ listStyle: "none", margin: 0, padding: 0 }),',
        f'  row: css({{ display: "flex", gap: {gap}, padding: "6px 0", borderBottom: tokens.border.subtle }}),',
        '  label: css({ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }),',
        '  empty: css({ color: tokens.color.muted, padding: tokens.space.lg }),',
        '  skeleton: css({ height: 48, borderRadius: tokens.radius.md, background: tokens.color.skeleton }),',
        '}',
        '',
    ])


def ts_index(names: list[str]) -> str:
    return ''.join(f"export * from './{name}'\n" for name in names)


def ts_hook(name: str, feature: str) -> str:
    noun = FEATURES[feature]
    t = pascal(noun)
    return '\n'.join([
        "import { useEffect, useMemo, useState } from 'react'",
        f"import type {{ {t} }} from '../model/types'",
        f"import {{ fetch{pascal(feature)} }} from '../api/client'",
        '',
        f'export function {name}(filters: Partial<{t}> = {{}}) {{',
        f'  const [items, setItems] = useState<{t}[]>([])',
        '  const [error, setError] = useState<Error | null>(null)',
        '  const key = useMemo(() => JSON.stringify(filters), [filters])',
        '',
        '  useEffect(() => {',
        '    const controller = new AbortController()',
        f'    fetch{pascal(feature)}(filters, controller.signal).then(setItems, (cause: Error) => {{',
        "      if (cause.name !== 'AbortError') setError(cause)",
        '    })',
        '    return () => controller.abort()',
        '  }, [key])',
        '',
        '  return { items, error, loading: !items.length && !error }',
        '}',
        '',
    ])


def ts_hook_test(name: str) -> str:
    return '\n'.join([
        "import { describe, expect, it } from '../../../../tests/harness'",
        f"import {{ {name} }} from './{name}'",
        '',
        f"describe('{name}', () => {{",
        "  it('starts loading', () => {",
        f'    const result = renderHook(() => {name}())',
        '    expect(result.current.loading).toBe(true)',
        '  })',
        '})',
        '',
    ])


def ts_api(feature: str) -> str:
    noun = FEATURES[feature]
    t = pascal(noun)
    path = kebab(feature)
    return '\n'.join([
        "import { request } from '../../../lib/http/client'",
        f"import type {{ {t} }} from '../model/types'",
        '',
        f"const BASE = '/api/v3/{path}'",
        '',
        f'export async function fetch{pascal(feature)}(filters: Partial<{t}>, signal?: AbortSignal): Promise<{t}[]> {{',
        '  const query = new URLSearchParams()',
        '  for (const [key, value] of Object.entries(filters)) {',
        '    if (value !== undefined && value !== null) query.set(key, String(value))',
        '  }',
        f'  const response = await request<{{ items: {t}[] }}>(`${{BASE}}?${{query}}`, {{ signal }})',
        '  return response.items',
        '}',
        '',
        f'export function fetch{t}(id: string, signal?: AbortSignal): Promise<{t}> {{',
        f'  return request<{t}>(`${{BASE}}/${{encodeURIComponent(id)}}`, {{ signal }})',
        '}',
        '',
    ])


def ts_types(feature: str) -> str:
    t = pascal(FEATURES[feature])
    extra = rng.sample([
        ('latitude', 'number'), ('longitude', 'number'), ('kp', 'number'), ('cloudCover', 'number'),
        ('visibility', "'none' | 'low' | 'fair' | 'good'"), ('observedAt', 'string'),
        ('stationId', 'string'), ('tags', 'string[]'), ('notes', 'string'), ('rating', '1 | 2 | 3 | 4 | 5'),
    ], 5)
    return '\n'.join([
        f'export type {t} = {{',
        '  id: string',
        '  createdAt: string',
        '  updatedAt: string',
        *[f'  {name}: {kind}' for name, kind in extra],
        '}',
        '',
        f'export type {t}Page = {{ items: {t}[]; next: string | null }}',
        '',
    ])


def ts_store(feature: str) -> str:
    t = pascal(FEATURES[feature])
    return '\n'.join([
        "import { createStore } from '../../../lib/state/store'",
        f"import type {{ {t} }} from './types'",
        '',
        f'type State = {{ byId: Record<string, {t}>; order: string[]; selected: string | null }}',
        '',
        f"export const {camel(feature)}Store = createStore<State>('{feature}', {{ byId: {{}}, order: [], selected: null }})",
        '',
        f'export function put{t}s(items: {t}[]): void {{',
        f'  {camel(feature)}Store.update((state) => {{',
        '    for (const item of items) state.byId[item.id] = item',
        '    state.order = items.map((item) => item.id)',
        '  })',
        '}',
        '',
    ])


def ts_generic(module: str, words: str) -> str:
    fn = camel(words)
    title = words[:1].upper() + words[1:]
    lines = [f'// {title} helpers for {module}.', '']
    lines += [
        '/**',
        f' * Normalizes {words} input: trims it, folds runs of spaces and keeps Unicode in NFC,',
        ' * so values typed by observers compare equal to the ones stored by the API.',
        ' */',
        f'export function {fn}(input: string): string {{',
        '  if (!input) return input',
        "  return input.normalize('NFC').trim().replace(/\\s+/g, ' ')",
        '}',
        '',
    ]
    for verb in rng.sample(['parse', 'format', 'is', 'to', 'from', 'merge', 'compare', 'describe'], rng.randint(2, 5)):
        lines += [
            f'/** {pascal(verb)}s a {words} value; strings pass through unchanged. */',
            f'export function {verb}{pascal(words)}(value: unknown): string {{',
            "  if (typeof value === 'string') return value",
            "  if (value === null || value === undefined) return ''",
            "  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : ''",
            '  return JSON.stringify(value)',
            '}',
            '',
        ]
    return '\n'.join(lines)


def ts_generic_test(module: str, words: str) -> str:
    fn = camel(words)
    return '\n'.join([
        "import { describe, expect, it } from '../../../tests/harness'",
        f"import {{ {fn} }} from './{kebab(words)}'",
        '',
        f"describe('{fn}', () => {{",
        "  it('keeps plain text', () => {",
        f"    expect({fn}('Kp 5 over Tromsø')).toBe('Kp 5 over Tromsø')",
        '  })',
        '',
        "  it('folds spaces', () => {",
        f"    expect({fn}('  clear   sky ')).toBe('clear sky')",
        '  })',
        '',
        "  it('keeps an empty string', () => {",
        f"    expect({fn}('')).toBe('')",
        '  })',
        '})',
        '',
    ])


ROUTER_TS = """\
import { lazy } from 'react'
import { createRouter } from '../lib/routing/router'
import type { Route } from '../lib/routing/router'
import { requireSession } from '../lib/auth/guards'

const page = (name: string) =>
  lazy(() => import(`../pages/${name}/index.ts`))

export const routes: Route[] = [
  { path: '/', view: page('home') },
  { path: '/forecast', view: page('forecast') },
  { path: '/tonight', view: page('tonight') },
  { path: '/map', view: page('map') },
  { path: '/sightings', view: page('sightings') },
  { path: '/sightings/:id', view: page('sighting') },
  {
    path: '/report',
    view: page('report-sighting'),
    guard: requireSession,
  },
  { path: '/gallery', view: page('gallery') },
  { path: '/events', view: page('events') },
  { path: '/tours/:id', view: page('tour') },
  {
    path: '/settings',
    view: page('settings'),
    guard: requireSession,
  },
  { path: '*', view: page('not-found') },
]

export const router = createRouter(routes, {
  base: import.meta.env.BASE_URL,
  scroll: 'top',
})
"""

HTTP_CLIENT_TS = """\
import { HttpError, NetworkError } from './errors'
import { withRetry } from './retry'

const API_ORIGIN = import.meta.env.API_ORIGIN ?? 'https://api.aurora.example.com'

export type RequestOptions = RequestInit & { retries?: number; timeoutMs?: number }

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { retries = 2, timeoutMs = 10_000, headers, ...init } = options
  const url = new URL(path, API_ORIGIN)
  return withRetry(retries, async () => {
    const timeout = AbortSignal.timeout(timeoutMs)
    const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout
    let response: Response
    try {
      response = await fetch(url, {
        ...init,
        signal,
        headers: { accept: 'application/json', ...headers },
      })
    } catch (cause) {
      throw new NetworkError(url.pathname, { cause })
    }
    if (!response.ok) throw new HttpError(response.status, url.pathname)
    return (await response.json()) as T
  })
}
"""

README_MD = """\
# Aurora Web

The web app of the Aurora sky-watching project:
tonight's aurora forecast, the Kp index and solar
wind, cloud cover, a map of sightings and a
gallery of photos sent in by observers.

## Run it

```sh
npm ci
npm run dev   # http://localhost:5173
npm test
```

The app reads its data from
`https://api.aurora.example.com`. Set `API_ORIGIN`
to `http://192.0.2.10:8080` for the staging API.

## Layout

- `src/app`: entry, router and providers
- `src/features`: api, components, hooks, model
- `src/components`: shared components
- `src/lib`: HTTP, i18n, storage, time, units
- `locales`: one JSON file per language
- `vendor`: the star catalog jar and icon set

See `docs/getting-started.md` for more.
"""


CHANGELOG_MD = """\
# Changelog

## 3.2.0 - 2026-11-03

- Tonight shows cloud cover hour by hour.
- The sightings map groups nearby reports.
- Kp alerts can be muted per location.
- The gallery loads photos as you scroll.
- Star names on the sky map come from the
  observatory catalog (vendor/).

## 3.1.4 - 2026-10-12

- The forecast chart reads right to left in
  Arabic and Hebrew.
- Tonight's times are right for locations
  east of UTC+12.

## 3.1.3 - 2026-09-28

- Faster start: the map loads its tiles
  after the forecast.
- Settings keep the units you picked.

## 3.1.2 - 2026-09-09

- Sighting reports keep their photo when
  the upload is retried.
"""


def json_text(value: object) -> str:
    return json.dumps(value, indent=2, ensure_ascii=False) + '\n'


def markdown_doc(slug: str) -> str:
    title = slug.replace('-', ' ').capitalize()
    paragraphs = rng.randint(4, 9)
    words = ['forecast', 'cloud cover', 'the Kp index', 'sightings', 'the map', 'locales', 'the API',
             'the cache', 'offline mode', 'tests', 'the router', 'release builds']
    out = [f'# {title}', '']
    for index in range(paragraphs):
        a, b = rng.sample(words, 2)
        out += [
            f'## {pascal(a).replace("The", "")} and {b}' if index % 3 == 0 else '',
            f'This page explains how {a} relates to {b} in Aurora Web. Keep changes small and',
            f'covered by tests; run `npm test` before opening a pull request.',
            '',
        ]
    return '\n'.join(line for line in out if line is not None) + '\n'


def locale_json(code: str) -> str:
    keys = {
        'app.title': 'Aurora',
        'nav.forecast': 'Forecast',
        'nav.tonight': 'Tonight',
        'nav.map': 'Map',
        'nav.sightings': 'Sightings',
        'nav.gallery': 'Gallery',
        'forecast.kp': 'Kp index',
        'forecast.clouds': 'Cloud cover',
        'forecast.chance': 'Chance of aurora',
        'sightings.report': 'Report a sighting',
        'settings.units': 'Units',
        'settings.language': 'Language',
    }
    for index in range(rng.randint(120, 260)):
        feature = rng.choice(list(FEATURES))
        keys[f'{feature}.text{index}'] = f'{pascal(FEATURES[feature])} {index}'
    return json_text({'locale': code, 'messages': keys})


def svg_icon(seed: int) -> str:
    r = random.Random(seed)
    shapes = []
    for _ in range(r.randint(1, 3)):
        x, y, s = r.randint(3, 13), r.randint(3, 13), r.randint(3, 8)
        shapes.append(f'<circle cx="{x}" cy="{y}" r="{s}" />')
    return ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" '
            'stroke="currentColor" stroke-width="1.5">' + ''.join(shapes) + '</svg>\n')


# ---------------------------------------------------------------------------------------------
# The project tree


def project_files(jar: bytes, png: bytes) -> dict[str, bytes]:
    files: dict[str, str | bytes] = {}

    def put(path: str, content: str | bytes) -> None:
        assert path not in files, path
        files[path] = content

    put('README.md', README_MD)
    put('CHANGELOG.md', CHANGELOG_MD)
    put('LICENSE', 'MIT License\n\nCopyright (c) 2026 Aurora Web contributors\n\n'
        'Permission is hereby granted, free of charge, to any person obtaining a copy of this software.\n')
    put('package.json', json_text({
        'name': 'aurora-web', 'version': '3.2.0', 'private': True, 'type': 'module',
        'scripts': {'dev': 'node scripts/dev.mjs', 'build': 'node scripts/build.mjs', 'test': 'node scripts/test.mjs'},
        'dependencies': {'aurora-icons': 'file:vendor/aurora-icons-1.4.0.tgz'},
    }))
    put('tsconfig.json', json_text({'compilerOptions': {'target': 'ES2022', 'module': 'ESNext', 'jsx': 'react-jsx',
                                                        'strict': True, 'moduleResolution': 'Bundler'}, 'include': ['src', 'tests']}))
    put('build.config.ts', "export default {\n  entry: 'src/app/main.tsx',\n  outDir: 'dist',\n  publicDir: 'public',\n}\n")
    put('.editorconfig', 'root = true\n\n[*]\nindent_style = space\nindent_size = 2\n')
    put('.gitignore', 'node_modules/\ndist/\ncoverage/\n')
    put('.github/workflows/ci.yml', 'name: ci\non: [push, pull_request]\njobs:\n  test:\n    runs-on: ubuntu-latest\n'
        '    steps:\n      - run: npm ci\n      - run: npm test\n')
    put('.github/workflows/release.yml', 'name: release\non:\n  push:\n    tags: [v*]\n')
    put('.github/pull_request_template.md', '## What changes\n\n## How it was tested\n')

    for slug in DOCS:
        put(f'docs/{slug}.md', markdown_doc(slug))
    for code in LOCALES:
        put(f'locales/{code}.json', locale_json(code))

    put('public/favicon.svg', svg_icon(1))
    put('public/robots.txt', 'User-agent: *\nAllow: /\n')
    put('public/site.webmanifest', json_text({'name': 'Aurora', 'start_url': '/', 'display': 'standalone'}))
    put('public/images/hero.png', png)
    put('public/images/logo.svg', svg_icon(2))
    put('public/images/placeholder.svg', svg_icon(3))
    for index, name in enumerate(['aurora', 'camera', 'cloud', 'compass', 'eye', 'globe', 'kp', 'location',
                                  'moon', 'star', 'sun', 'telescope', 'wind', 'bell', 'calendar', 'map']):
        put(f'public/icons/{name}.svg', svg_icon(100 + index))

    for name in ['build', 'dev', 'test', 'check-locales', 'icons', 'release']:
        put(f'scripts/{name}.mjs', f"// {name} script for Aurora Web.\nimport {{ run }} from './lib.mjs'\n\nawait run('{name}')\n")
    put('scripts/lib.mjs', "export async function run(task) {\n  console.log(`aurora-web: ${task}`)\n}\n")

    # src/app
    put('src/app/main.tsx', "import { createRoot } from 'react-dom/client'\nimport { App } from './App'\n\n"
        "createRoot(document.getElementById('root')!).render(<App />)\n")
    put('src/app/App.tsx', "import { RouterView } from '../lib/routing/router'\nimport { Providers } from './providers'\n"
        "import { router } from './router'\n\nexport function App() {\n  return (\n    <Providers>\n"
        "      <RouterView router={router} />\n    </Providers>\n  )\n}\n")
    put('src/app/providers.tsx', "import type { ReactNode } from 'react'\n\nexport function Providers({ children }: "
        "{ children: ReactNode }) {\n  return <>{children}</>\n}\n")
    put('src/app/router.ts', ROUTER_TS)
    put('src/app/env.ts', "export const env = {\n  apiOrigin: import.meta.env.API_ORIGIN ?? 'https://api.aurora.example.com',\n}\n")
    put('src/app/theme.ts', "export const theme = { dark: 'dark', light: 'light' } as const\n")

    # src/components
    for words in SHARED_COMPONENTS:
        name = pascal(words)
        base = f'src/components/{name}'
        put(f'{base}/{name}.tsx', ts_component(name, None))
        put(f'{base}/{name}.test.tsx', ts_component_test(name))
        put(f'{base}/{name}.styles.ts', ts_styles(name))
        put(f'{base}/index.ts', ts_index([name]))

    # src/features
    for feature in FEATURES:
        base = f'src/features/{feature}'
        put(f'{base}/api/client.ts', ts_api(feature))
        put(f'{base}/api/client.test.ts', ts_generic_test(feature, f'{FEATURES[feature]} request'))
        put(f'{base}/api/mocks.ts', ts_generic(feature, f'{FEATURES[feature]} mocks'))
        put(f'{base}/model/types.ts', ts_types(feature))
        put(f'{base}/model/store.ts', ts_store(feature))
        put(f'{base}/model/store.test.ts', ts_generic_test(feature, f'{FEATURES[feature]} store'))
        put(f'{base}/model/selectors.ts', ts_generic(feature, f'{FEATURES[feature]} selectors'))
        names = []
        noun = pascal(FEATURES[feature])
        for suffix in rng.sample(COMPONENT_SUFFIXES, rng.randint(8, 12)):
            name = noun + pascal(suffix)
            names.append(name)
            put(f'{base}/components/{name}/{name}.tsx', ts_component(name, feature))
            put(f'{base}/components/{name}/{name}.test.tsx', ts_component_test(name))
            put(f'{base}/components/{name}/{name}.styles.ts', ts_styles(name))
        put(f'{base}/components/index.ts', ts_index([f'{n}/{n}' for n in names]))
        for suffix in rng.sample(HOOK_SUFFIXES, rng.randint(3, 6)):
            hook = 'use' + pascal(feature) + pascal(suffix)
            put(f'{base}/hooks/{hook}.ts', ts_hook(hook, feature))
            put(f'{base}/hooks/{hook}.test.ts', ts_hook_test(hook))
        put(f'{base}/routes.ts', f"export const {camel(feature)}Routes = ['/{feature}', '/{feature}/:id']\n")
        put(f'{base}/index.ts', "export * from './components'\nexport * from './model/types'\n")

    # src/lib
    put('src/lib/http/client.ts', HTTP_CLIENT_TS)
    for area, modules in LIB_AREAS.items():
        for words in modules:
            path = f'src/lib/{area}/{kebab(words)}.ts'
            if path in files:
                continue
            put(path, ts_generic(area, words))
            put(f'src/lib/{area}/{kebab(words)}.test.ts', ts_generic_test(area, words))
    put('src/lib/state/store.ts', "export function createStore<T>(name: string, initial: T) {\n  let state = initial\n"
        "  return { name, get: () => state, update(fn: (draft: T) => void) { fn(state) } }\n}\n")
    put('src/lib/routing/router.ts', "export type Route = { path: string; component?: unknown; guard?: unknown; "
        "preload?: string[]; loader?: () => unknown }\nexport function createRouter(routes: Route[], options: object) "
        "{\n  return { routes, options }\n}\nexport function redirect(to: string) {\n  return { redirect: to }\n}\n"
        "export function RouterView(_: { router: unknown }) {\n  return null\n}\n")

    # src/hooks, src/utils, src/pages, src/styles, src/types
    for words in SHARED_HOOKS:
        hook = 'use' + pascal(words)
        put(f'src/hooks/{hook}.ts', ts_generic('hooks', words).replace(f'function {camel(words)}', f'function {hook}', 1))
        put(f'src/hooks/{hook}.test.ts', ts_generic_test('hooks', words))
    for words in UTILS:
        put(f'src/utils/{kebab(words)}.ts', ts_generic('utils', words))
        put(f'src/utils/{kebab(words)}.test.ts', ts_generic_test('utils', words))
    for words in PAGES:
        name = pascal(words) + 'Page'
        put(f'src/pages/{kebab(words)}/{name}.tsx', ts_component(name, None))
        put(f'src/pages/{kebab(words)}/{name}.test.tsx', ts_component_test(name))
        put(f'src/pages/{kebab(words)}/index.ts', f"export {{ {name} as default }} from './{name}'\n")
    for name in ['tokens', 'css', 'breakpoints', 'motion', 'z-index', 'typography', 'colors', 'spacing']:
        put(f'src/styles/{name}.ts', ts_generic('styles', name.replace('-', ' ')))
    for name in ['api', 'env', 'geo', 'i18n', 'routes', 'units', 'events', 'global']:
        put(f'src/types/{name}.d.ts', f'// Shared {name} types.\nexport type {pascal(name)}Id = string\n')

    # tests
    for words in PAGES[:24]:
        put(f'tests/e2e/{kebab(words)}.spec.ts', ts_generic_test('e2e', words).replace('../../../tests/harness', '../harness'))
    put('tests/harness.ts', "export { describe, expect, it } from './runner'\n")
    put('tests/runner.ts', "export const describe = (_: string, fn: () => void) => fn()\nexport const it = describe\n"
        "export const expect = (value: unknown) => ({ toBe: (_: unknown) => value, toBeDefined: () => value })\n")
    for index in range(8):
        put(f'tests/fixtures/sightings-{index + 1}.json', json_text([
            {'id': f's-{index}-{n}', 'latitude': round(rng.uniform(60, 70), 3), 'longitude': round(rng.uniform(5, 30), 3),
             'kp': rng.randint(2, 7), 'observedAt': f'2026-10-{rng.randint(1, 28):02d}T22:{rng.randint(0, 59):02d}:00Z'}
            for n in range(rng.randint(10, 40))
        ]))

    put('vendor/README.md', '# Vendored files\n\n- `observatory-2.0.0.jar` - the star catalog used by the sky map.\n'
        '- `aurora-icons-1.4.0.tgz` - the icon set, as published.\n')
    put('vendor/observatory-2.0.0.jar', jar)
    put('vendor/aurora-icons-1.4.0.tgz', icons_tgz())

    return {path: content.encode('utf-8') if isinstance(content, str) else content for path, content in files.items()}


def icons_tgz() -> bytes:
    stamp = datetime(2026, 9, 21, 10, 4, tzinfo=timezone.utc).timestamp()
    buffer = io.BytesIO()
    # GzipFile with a fixed mtime, so the .tgz (and the archives around it) are the same on every run.
    with gzip.GzipFile(filename='', mode='wb', fileobj=buffer, mtime=int(stamp)) as packed, \
            tarfile.open(fileobj=packed, mode='w', format=tarfile.PAX_FORMAT) as tar:
        entries = {
            'package/package.json': json_text({'name': 'aurora-icons', 'version': '1.4.0', 'license': 'MIT'}),
            'package/README.md': '# aurora-icons\n\nLine icons for Aurora, 24 x 24, stroke 1.5.\n',
            'package/LICENSE': 'MIT License\n\nCopyright (c) 2026 Aurora Web contributors\n',
        }
        for index in range(48):
            entries[f'package/icons/icon-{index + 1:02d}.svg'] = svg_icon(500 + index)
        for path, text in entries.items():
            data = text.encode('utf-8')
            info = tarfile.TarInfo(path)
            info.size = len(data)
            info.mtime = int(stamp)
            info.mode = 0o644
            tar.addfile(info, io.BytesIO(data))
    return buffer.getvalue()


def neutral_jar(jar: bytes) -> bytes:
    """The shared jar with its dates moved to the vendoring day and no JDK vendor in MANIFEST.MF.
    The class files are copied byte for byte."""
    out = io.BytesIO()
    with zipfile.ZipFile(io.BytesIO(jar)) as source, zipfile.ZipFile(out, 'w') as target:
        for info in source.infolist():
            data = source.read(info)
            if info.filename == 'META-INF/MANIFEST.MF':
                lines = data.decode('utf-8').split('\r\n' if b'\r\n' in data else '\n')
                lines = [line.split(' (')[0] if line.startswith('Created-By:') else line for line in lines]
                data = ('\r\n' if b'\r\n' in data else '\n').join(lines).encode('utf-8')
            copy = zipfile.ZipInfo(info.filename, date_time=(2026, 10, 28, 16, 20, 0))
            copy.compress_type = info.compress_type
            copy.external_attr = info.external_attr
            copy.create_system = info.create_system
            target.writestr(copy, data)
    return out.getvalue()


# ---------------------------------------------------------------------------------------------
# Writers


def day_times(paths: list[str]) -> dict[str, tuple[int, int, int, int, int, int]]:
    """A time on 2026-11-03 for each path, in path order, between 09:12 and 17:48."""
    times = {}
    for path in paths:
        minute = rng.randint(9 * 60 + 12, 17 * 60 + 48)
        times[path] = (*DAY, minute // 60, minute % 60, rng.randrange(0, 60, 2))
    return times


def folders_of(paths: list[str]) -> list[str]:
    folders = set()
    for path in paths:
        parts = path.split('/')[:-1]
        for index in range(1, len(parts) + 1):
            folders.add('/'.join(parts[:index]))
    return sorted(folders)


def write_zip(target: Path, files: dict[str, bytes], times: dict, top: str) -> None:
    with zipfile.ZipFile(target, 'w') as archive:
        for folder in ['', *folders_of(list(files))]:
            name = f'{top}/{folder}' if folder else top
            info = zipfile.ZipInfo(name + '/', date_time=times.get(folder, (*DAY, 17, 48, 0)))
            info.create_system = 0
            info.external_attr = 0x10
            archive.writestr(info, b'')
        for path, data in files.items():
            info = zipfile.ZipInfo(f'{top}/{path}', date_time=times[path])
            info.create_system = 0
            info.external_attr = 0x20
            # Like Info-ZIP: Deflate, or Stored when that does not make the file smaller.
            packed = zlib.compressobj(6, zlib.DEFLATED, -15)
            size = len(packed.compress(data) + packed.flush())
            info.compress_type = zipfile.ZIP_DEFLATED if size < len(data) else zipfile.ZIP_STORED
            archive.writestr(info, data)


def write_tar_xz(target: Path, files: dict[str, bytes], times: dict, top: str) -> None:
    def stamp(value: tuple) -> int:
        return int(datetime(*value, tzinfo=timezone.utc).timestamp())

    with tarfile.open(target, 'w:xz', format=tarfile.PAX_FORMAT) as tar:
        for folder in ['', *folders_of(list(files))]:
            info = tarfile.TarInfo(f'{top}/{folder}' if folder else top)
            info.type = tarfile.DIRTYPE
            info.mode = 0o755
            info.mtime = stamp(times.get(folder, (*DAY, 17, 48, 0)))
            info.uname = info.gname = 'aurora'
            info.uid = info.gid = 1000
            tar.addfile(info)
        for path, data in files.items():
            info = tarfile.TarInfo(f'{top}/{path}')
            info.size = len(data)
            info.mode = 0o755 if path.startswith('scripts/') else 0o644
            info.mtime = stamp(times[path])
            info.uname = info.gname = 'aurora'
            info.uid = info.gid = 1000
            tar.addfile(info, io.BytesIO(data))


MATERIALS = ['Кирпич облицовочный', 'Цемент М500', 'Песок речной', 'Щебень гранитный',
             'Арматура А500С', 'Профлист С21', 'Утеплитель', 'Мембрана', 'Саморезы кровельные',
             'Доска обрезная', 'Брус', 'Плёнка пароизоляционная', 'Окно ПВХ', 'Подоконник',
             'Краска фасадная', 'Грунтовка', 'Штукатурка', 'Сетка фасадная', 'Водосток', 'Отлив']
UNITS = ['шт.', 'т', 'куб. м', 'кв. м', 'м', 'уп.']


def estimate_csv() -> str:
    """A cost estimate with a few hundred rows, so the archive is not all headers."""
    rows = ['№;Позиция;Ед.;Кол-во;Цена, руб.;Сумма, руб.']
    for number in range(1, 241):
        name = f'{rng.choice(MATERIALS)}, партия {rng.randint(1, 12)}'
        amount, price = rng.randint(1, 400), rng.randrange(150, 9000, 10)
        rows.append(f'{number};{name};{rng.choice(UNITS)};{amount};{price};{amount * price}')
    return '\n'.join(rows) + '\n'


def reconciliation_csv() -> str:
    rows = ['Дата;Документ;Приход, руб.;Расход, руб.']
    for day in range(1, 91):
        month = 1 + (day - 1) // 30
        rows.append(f'{(day - 1) % 30 + 1:02d}.{month:02d}.2019;Накладная {1000 + day};'
                    f'{rng.randrange(0, 90000, 100)};{rng.randrange(0, 90000, 100)}')
    return '\n'.join(rows) + '\n'


# A small office's 2019 projects, zipped by Windows Explorer on a Russian system: names in the
# OEM code page 866 without the UTF-8 flag, text files in Windows-1251.
RUSSIAN_FILES: dict[str, str | Callable[[], str]] = {
    'Бюджет/Смета на 2019 год.csv': estimate_csv,
    'Бюджет/Сверка за I квартал.csv': reconciliation_csv,
    'Договоры/Договор № 17.txt': 'Договор поставки № 17\n\nПоставщик обязуется передать покупателю товар\nв сроки, указанные в приложении 1.\n',
    'Договоры/График поставок.txt': 'Приложение 1 к договору № 17\n\nПервая партия: до 15 марта.\nВторая партия: до 30 апреля.\n',
    'Договоры/Акт сверки.txt': 'Акт сверки взаимных расчётов за I квартал 2019 года.\n',
    'Отчёты/Отчёт за I квартал.txt': (
        'Отчёт за I квартал 2019 года\n\n'
        '1. Объект «Северный склад» готов на 80 %.\n'
        '2. Кровля смонтирована, идёт отделка фасада.\n'
        '3. Поставка окон перенесена на апрель.\n\n'
        'Итого по смете: 714 700 руб., освоено 571 760 руб.\n\n'
        'Ответственный: прораб участка № 2\n'
    ),
    'Отчёты/Отчёт за II квартал.txt': 'Отчёт за II квартал 2019 года\n\nОбъект сдан заказчику 28 июня.\n',
    'Отчёты/Фотоотчёт.txt': 'Снимок 1 — фасад, вид с юга.\nСнимок 2 — кровля после монтажа.\n',
    'Переписка/Письмо от 12.02.txt': 'Уважаемые коллеги!\n\nНаправляем график работ на февраль.\n',
    'Переписка/Ответ на претензию.txt': 'Претензия рассмотрена, сроки поставки согласованы заново.\n',
    'Планы/План работ, март.txt': 'Неделя 1 — кровля.\nНеделя 2 — окна.\nНеделя 3 — фасад.\nНеделя 4 — уборка.\n',
    'Планы/Чек-лист приёмки.txt': '— Кровля без протечек\n— Окна открываются\n— Фасад без трещин\n',
    'Прочти меня.txt': 'В архиве документы по объекту «Северный склад» за 2019 год.\n',
}

RUSSIAN_DATES = {
    'Бюджет/Смета на 2019 год.csv': (2019, 1, 21, 10, 14, 6),
    'Бюджет/Сверка за I квартал.csv': (2019, 4, 3, 16, 2, 40),
    'Договоры/Договор № 17.txt': (2019, 2, 6, 11, 30, 12),
    'Договоры/График поставок.txt': (2019, 2, 6, 11, 41, 58),
    'Договоры/Акт сверки.txt': (2019, 4, 10, 9, 5, 22),
    'Отчёты/Отчёт за I квартал.txt': (2019, 4, 1, 18, 22, 4),
    'Отчёты/Отчёт за II квартал.txt': (2019, 7, 2, 12, 47, 30),
    'Отчёты/Фотоотчёт.txt': (2019, 3, 29, 15, 10, 0),
    'Переписка/Письмо от 12.02.txt': (2019, 2, 12, 14, 0, 46),
    'Переписка/Ответ на претензию.txt': (2019, 5, 17, 10, 33, 18),
    'Планы/План работ, март.txt': (2019, 2, 27, 17, 55, 2),
    'Планы/Чек-лист приёмки.txt': (2019, 6, 20, 8, 48, 36),
    'Прочти меня.txt': (2019, 7, 5, 9, 12, 10),
}


def dos_stamp(value: tuple) -> tuple[int, int]:
    year, month, day, hour, minute, second = value
    return (hour << 11) | (minute << 5) | (second // 2), ((year - 1980) << 9) | (month << 5) | day


def write_cp866_zip(target: Path) -> None:
    """Written by hand: Python's zipfile (3.14) sets the UTF-8 flag on every name it writes."""
    top = 'Проекты 2019'
    entries: list[tuple[str, bytes, tuple]] = []
    for folder in ['', *folders_of(list(RUSSIAN_FILES))]:
        entries.append((f'{top}/{folder}/' if folder else f'{top}/', b'', (2019, 7, 5, 9, 14, 0)))
    for path, text in RUSSIAN_FILES.items():
        body = text() if callable(text) else text
        entries.append((f'{top}/{path}', body.replace('\n', '\r\n').encode('cp1251'), RUSSIAN_DATES[path]))

    body = bytearray()
    central = bytearray()
    for name, data, stamp in entries:
        raw = name.encode('cp866')
        time, date = dos_stamp(stamp)
        crc = zlib.crc32(data)
        packer = zlib.compressobj(9, zlib.DEFLATED, -15)
        packed = packer.compress(data) + packer.flush() if data else b''
        method = 8 if data else 0
        offset = len(body)
        # Version 2.0, flags 0 (no UTF-8 flag), MS-DOS host.
        body += struct.pack('<IHHHHHIIIHH', 0x04034B50, 20, 0, method, time, date, crc,
                            len(packed), len(data), len(raw), 0) + raw + packed
        attributes = 0x10 if name.endswith('/') else 0x20
        central += struct.pack('<IHHHHHHIIIHHHHHII', 0x02014B50, 20, 20, 0, method, time, date,
                               crc, len(packed), len(data), len(raw), 0, 0, 0, 0, attributes,
                               offset) + raw
    end = struct.pack('<IHHHHIIH', 0x06054B50, 0, 0, len(entries), len(entries), len(central),
                      len(body), 0)
    target.write_bytes(bytes(body + central + end))

    with zipfile.ZipFile(target) as check:
        assert check.testzip() is None
        assert all(not info.flag_bits & 0x800 for info in check.infolist()), 'UTF-8 flag set'
        assert len(check.infolist()) == len(entries)


# ---------------------------------------------------------------------------------------------


def png_rows(png: bytes, top: int, height: int) -> bytes:
    """Rows top..top+height of an 8-bit RGB or RGBA PNG without interlacing, as a new PNG (each
    row with the Up filter). The listing's hero is a wide banner cut from the 1600 x 1000 render."""
    if png[:8] != b'\x89PNG\r\n\x1a\n':
        sys.exit('make-listing-samples: sunset.png is not a PNG')
    at, header, packed = 8, b'', bytearray()
    while at < len(png):
        length, kind = struct.unpack('>I4s', png[at:at + 8])
        data = png[at + 8:at + 8 + length]
        at += 12 + length
        if kind == b'IHDR':
            header = data
        elif kind == b'IDAT':
            packed += data
        elif kind == b'IEND':
            break
    width, rows, depth, color, _, _, interlace = struct.unpack('>IIBBBBB', header)
    if depth != 8 or color not in (2, 6) or interlace or top + height > rows:
        sys.exit('make-listing-samples: sunset.png must be 8-bit RGB(A), not interlaced, tall enough')
    bpp = 3 if color == 2 else 4
    stride = width * bpp
    raw = zlib.decompress(bytes(packed))
    previous = bytearray(stride)
    kept = []
    for y in range(top + height):
        start = y * (stride + 1)
        kind, line = raw[start], bytearray(raw[start + 1:start + 1 + stride])
        if kind == 1:
            for i in range(bpp, stride):
                line[i] = (line[i] + line[i - bpp]) & 255
        elif kind == 2:
            line = bytearray((a + b) & 255 for a, b in zip(line, previous))
        elif kind == 3:
            for i in range(stride):
                left = line[i - bpp] if i >= bpp else 0
                line[i] = (line[i] + ((left + previous[i]) >> 1)) & 255
        elif kind == 4:
            for i in range(stride):
                a = line[i - bpp] if i >= bpp else 0
                b = previous[i]
                c = previous[i - bpp] if i >= bpp else 0
                pa, pb, pc = abs(b - c), abs(a - c), abs(a + b - 2 * c)
                line[i] = (line[i] + (a if pa <= pb and pa <= pc else b if pb <= pc else c)) & 255
        if y >= top:
            kept.append(bytes(line))
        previous = line
    out = bytearray()
    above = bytes(stride)
    for line in kept:
        out.append(2)
        out += bytes((a - b) & 255 for a, b in zip(line, above))
        above = line

    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data))

    ihdr = struct.pack('>IIBBBBB', width, height, 8, color, 0, 0, 0)
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', ihdr) + chunk(b'IDAT', zlib.compress(bytes(out), 9))
            + chunk(b'IEND', b''))


def find(given: str | None, candidates: list[Path], what: str) -> bytes:
    paths = [Path(given)] if given else candidates
    for path in paths:
        if path.is_file():
            return path.read_bytes()
    tried = '\n  '.join(str(path) for path in paths)
    sys.exit(f'make-listing-samples: {what} not found. Tried:\n  {tried}\n'
             f'Build it in its plugin first, or pass its path as an argument.')


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    parser.add_argument('--jar', help='observatory-2.0.0.jar (class-viewer)')
    parser.add_argument('--png', help='sunset.png (image-viewer)')
    parser.add_argument('--out', default=str(PLUGIN / '.orca/listing/samples'))
    args = parser.parse_args()

    jar = neutral_jar(find(args.jar, JAR_CANDIDATES, 'observatory-2.0.0.jar'))
    png = png_rows(find(args.png, PNG_CANDIDATES, 'sunset.png'), 170, 640)

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    files = project_files(jar, png)
    times = day_times([*files, *folders_of(list(files))])
    write_zip(out / f'{TOP}.zip', files, times, TOP)
    write_tar_xz(out / f'{TOP}.tar.xz', files, times, TOP)
    write_cp866_zip(out / 'projects-2019.zip')

    for name in [f'{TOP}.zip', f'{TOP}.tar.xz', 'projects-2019.zip']:
        print(f'{out / name}  {(out / name).stat().st_size:,} bytes')
    print(f'{len(files):,} files, {len(folders_of(list(files))) + 1:,} folders in {TOP}')


if __name__ == '__main__':
    main()
