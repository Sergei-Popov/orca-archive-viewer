// The page's CSS, built on the `--orca-*` theme variables so it follows Orca's light and dark
// themes; Orca updates the variables in place and toggles `light`/`dark` on <html>.

export const css = String.raw`
:root {
  --bg: var(--orca-background, #ffffff);
  --fg: var(--orca-foreground, #0a0a0a);
  --card: var(--orca-card, #ffffff);
  --muted: var(--orca-muted, #f5f5f5);
  --muted-fg: var(--orca-muted-foreground, #737373);
  --accent: var(--orca-accent, #f5f5f5);
  --accent-fg: var(--orca-accent-foreground, #171717);
  --border: var(--orca-border, #e5e5e5);
  --input: var(--orca-input, #e5e5e5);
  --primary: var(--orca-primary, #171717);
  --primary-fg: var(--orca-primary-foreground, #fafafa);
  --ring: var(--orca-ring, #a3a3a3);
  --destructive: var(--orca-destructive, #dc2626);
  --popover: var(--orca-popover, #ffffff);
  --popover-fg: var(--orca-popover-foreground, #0a0a0a);
  --radius: var(--orca-radius, 6px);
  --select: color-mix(in srgb, var(--primary) 12%, transparent);
  --select-strong: color-mix(in srgb, var(--primary) 18%, transparent);
  --folder: #c58f2a;
  --archive: #7c5cc4;
  --picture: #2f8f62;
  --warn: #b7791f;
  --check-a: #ffffff;
  --check-b: #ececec;
  --ui-font: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  --mono-font: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  --row: 24px;
  color-scheme: light;
}
:root.dark {
  --bg: var(--orca-background, #0a0a0a);
  --fg: var(--orca-foreground, #fafafa);
  --card: var(--orca-card, #0a0a0a);
  --muted: var(--orca-muted, #262626);
  --muted-fg: var(--orca-muted-foreground, #a3a3a3);
  --accent: var(--orca-accent, #262626);
  --accent-fg: var(--orca-accent-foreground, #fafafa);
  --border: var(--orca-border, #2e2e2e);
  --input: var(--orca-input, #2e2e2e);
  --primary: var(--orca-primary, #fafafa);
  --primary-fg: var(--orca-primary-foreground, #171717);
  --ring: var(--orca-ring, #737373);
  --destructive: var(--orca-destructive, #f87171);
  --popover: var(--orca-popover, #171717);
  --popover-fg: var(--orca-popover-foreground, #fafafa);
  --folder: #dcae55;
  --archive: #a68cf0;
  --picture: #5cc28f;
  --warn: #e0a84a;
  --check-a: #1c1c1c;
  --check-b: #262626;
  color-scheme: dark;
}
* { box-sizing: border-box; }
html, body { height: 100%; margin: 0; }
body {
  background: var(--bg);
  color: var(--fg);
  font: 12px/1.4 var(--ui-font);
  overflow: hidden;
  -webkit-font-smoothing: antialiased;
}
button, select, input { font: inherit; color: inherit; }
.av-icon { width: 14px; height: 14px; display: block; flex: none; }

.av-root { height: 100%; }
[hidden] { display: none !important; }
.av-app { display: flex; flex-direction: column; height: 100%; min-height: 0; position: relative; }

/* Toolbar */
.av-bar {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  padding: 6px 10px; border-bottom: 1px solid var(--border); background: var(--bg); min-height: 38px;
}
.av-crumbs { display: flex; align-items: center; gap: 2px; min-width: 0; flex-wrap: wrap; }
.av-crumb {
  border: 0; background: none; padding: 2px 6px; border-radius: 4px; cursor: pointer;
  color: var(--muted-fg); max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.av-crumb:hover { background: var(--accent); color: var(--accent-fg); }
.av-crumb[aria-current="true"] { color: var(--fg); font-weight: 600; cursor: default; background: none; }
.av-crumb-sep { color: var(--muted-fg); opacity: .6; }
.av-crumb-sep .av-icon { width: 12px; height: 12px; }
.av-summary { display: flex; align-items: center; gap: 8px; color: var(--muted-fg); white-space: nowrap; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.av-badge {
  font-size: 10.5px; font-weight: 600; letter-spacing: .02em; padding: 1px 6px; border-radius: 999px;
  background: var(--muted); color: var(--fg); border: 1px solid var(--border); white-space: nowrap;
}
.av-spacer { flex: 1; }
.av-field { display: flex; align-items: center; gap: 6px; color: var(--muted-fg); }
.av-select, .av-search input {
  height: 26px; border: 1px solid var(--input); border-radius: var(--radius); background: var(--bg); color: var(--fg);
}
.av-select { padding: 0 6px; }
.av-search { position: relative; display: flex; align-items: center; }
.av-search .av-icon { position: absolute; left: 7px; color: var(--muted-fg); pointer-events: none; }
.av-search input { width: 190px; padding: 0 8px 0 26px; }
.av-search input::placeholder { color: var(--muted-fg); }
.av-select:focus-visible, .av-search input:focus-visible, .av-btn:focus-visible, .av-crumb:focus-visible {
  outline: 2px solid var(--ring); outline-offset: 1px;
}
.av-btn {
  display: inline-flex; align-items: center; gap: 6px; height: 26px; padding: 0 9px;
  border: 1px solid var(--input); border-radius: var(--radius); background: var(--bg); color: var(--fg); cursor: pointer; white-space: nowrap;
}
.av-btn:hover:not(:disabled) { background: var(--accent); color: var(--accent-fg); }
.av-btn:disabled { opacity: .5; cursor: default; }
.av-btn.av-primary { background: var(--primary); color: var(--primary-fg); border-color: var(--primary); }
.av-btn.av-primary:hover:not(:disabled) { background: color-mix(in srgb, var(--primary) 88%, var(--bg)); color: var(--primary-fg); }
.av-btn.av-square { width: 26px; padding: 0; justify-content: center; }
.av-btn[aria-pressed="true"] { background: var(--select-strong); }

.av-notice {
  display: flex; align-items: center; gap: 8px; padding: 6px 12px; color: var(--warn);
  background: color-mix(in srgb, var(--warn) 10%, transparent); border-bottom: 1px solid var(--border);
}

/* Tree and preview side by side; stacked in a narrow tab. */
.av-main { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(240px, var(--tree, 52%)) 5px minmax(0, 1fr); }
.av-split { cursor: col-resize; background: var(--border); background-clip: content-box; padding: 0 2px; }
.av-split:hover, .av-split.av-dragging { background-color: var(--ring); }
@media (max-width: 720px) {
  .av-main { grid-template-columns: 1fr; grid-template-rows: minmax(160px, 45%) 1px minmax(0, 1fr); }
  .av-split { cursor: default; padding: 0; pointer-events: none; }
  .av-search input { width: 140px; }
}

.av-tree { display: flex; flex-direction: column; min-width: 0; min-height: 0; }
.av-cols {
  display: grid; grid-template-columns: var(--columns); gap: 8px; align-items: center;
  padding: 0 12px 0 52px; height: 26px; border-bottom: 1px solid var(--border);
  color: var(--muted-fg); font-size: 11px; font-weight: 500; user-select: none;
}
.av-cols span:not(:first-child), .av-cell { text-align: right; }
.av-scroll { position: relative; flex: 1; min-height: 0; overflow: auto; outline: none; }
.av-scroll:focus-visible:not([data-pointer]) { box-shadow: inset 0 0 0 1px var(--ring); }
.av-rows { position: absolute; left: 0; right: 0; top: 0; }
.av-row {
  display: grid; grid-template-columns: 16px 16px var(--columns); gap: 0 8px; align-items: center;
  height: var(--row); padding: 0 12px 0 0; cursor: default; white-space: nowrap; user-select: none;
}
.av-row > :nth-child(3) { margin-left: -4px; }
.av-row:hover { background: var(--accent); }
.av-row[aria-selected="true"] { background: var(--select); }
.av-scroll:focus .av-row[aria-selected="true"] { background: var(--select-strong); }
.av-twisty { display: flex; align-items: center; justify-content: center; color: var(--muted-fg); border-radius: 3px; }
.av-twisty .av-icon { width: 12px; height: 12px; transition: transform .12s; }
.av-twisty[data-open="true"] .av-icon { transform: rotate(90deg); }
.av-kind { display: flex; align-items: center; color: var(--muted-fg); }
.av-kind.av-folder { color: var(--folder); }
.av-kind.av-arch { color: var(--archive); }
.av-kind.av-pic { color: var(--picture); }
.av-kind.av-lock { color: var(--warn); }
.av-title .av-icon { color: var(--muted-fg); }
.av-title .av-folder { color: var(--folder); }
.av-title .av-arch { color: var(--archive); }
.av-title .av-pic { color: var(--picture); }
.av-title .av-lock { color: var(--warn); }
.av-name { overflow: hidden; text-overflow: ellipsis; }
.av-name mark { background: color-mix(in srgb, var(--warn) 35%, transparent); color: inherit; border-radius: 2px; }
.av-target { color: var(--muted-fg); margin-left: 6px; }
.av-dup { color: var(--warn); margin-left: 6px; font-size: 11px; }
.av-cell { color: var(--muted-fg); font-variant-numeric: tabular-nums; overflow: hidden; text-overflow: ellipsis; }
.av-dir .av-cell { opacity: .8; }
.av-empty { padding: 24px 16px; color: var(--muted-fg); text-align: center; }
.av-tree[data-packed="off"] .av-c-packed, .av-tree[data-date="off"] .av-c-date, .av-tree[data-size="off"] .av-c-size { display: none; }

/* Preview */
.av-preview { min-width: 0; min-height: 0; display: flex; flex-direction: column; overflow: hidden; position: relative; }
.av-head { padding: 12px 16px 10px; border-bottom: 1px solid var(--border); display: flex; flex-direction: column; gap: 8px; }
.av-title { display: flex; align-items: center; gap: 8px; min-width: 0; }
.av-title .av-icon { width: 18px; height: 18px; }
.av-title h2 { margin: 0; font-size: 14px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.av-path { color: var(--muted-fg); font-family: var(--mono-font); font-size: 11px; overflow-wrap: anywhere; }
.av-meta { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 3px 14px; margin: 0; }
.av-meta dt { color: var(--muted-fg); }
.av-meta dd { margin: 0; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.av-meta .av-mono { font-family: var(--mono-font); font-size: 11px; }
.av-actions { display: flex; gap: 6px; flex-wrap: wrap; }
.av-body { flex: 1; min-height: 0; overflow: auto; position: relative; }
.av-callout {
  margin: 12px 16px; padding: 10px 12px; border-radius: var(--radius); border: 1px solid var(--border);
  display: flex; gap: 10px; align-items: flex-start; background: var(--muted);
}
.av-callout .av-icon { width: 16px; height: 16px; margin-top: 1px; color: var(--muted-fg); }
.av-callout.av-warn { border-color: color-mix(in srgb, var(--warn) 45%, var(--border)); background: color-mix(in srgb, var(--warn) 9%, transparent); }
.av-callout.av-warn .av-icon { color: var(--warn); }
.av-callout.av-danger { border-color: color-mix(in srgb, var(--destructive) 45%, var(--border)); background: color-mix(in srgb, var(--destructive) 8%, transparent); }
.av-callout.av-danger .av-icon { color: var(--destructive); }
.av-callout strong { display: block; margin-bottom: 2px; }
.av-callout p { margin: 0; color: var(--muted-fg); }
.av-callout .av-actions { margin-top: 10px; }
.av-note { padding: 8px 16px 0; color: var(--muted-fg); }
.av-code { display: grid; grid-template-columns: max-content minmax(0, 1fr); font: 12px/1.55 var(--mono-font); min-width: max-content; }
.av-code.av-wrapped { min-width: 0; grid-template-columns: minmax(0, 1fr); }
.av-code.av-wrapped .av-gutter { display: none; }
.av-code.av-wrapped .av-text { white-space: pre-wrap; overflow-wrap: anywhere; }
.av-gutter, .av-text { margin: 0; padding: 10px 12px; font: inherit; }
.av-gutter { text-align: right; color: var(--muted-fg); opacity: .65; user-select: none; border-right: 1px solid var(--border); position: sticky; left: 0; background: var(--bg); }
.av-text { white-space: pre; tab-size: 4; user-select: text; }
.av-hex { margin: 0; padding: 10px 16px; font: 12px/1.55 var(--mono-font); white-space: pre; user-select: text; color: var(--fg); }
.av-image {
  height: 100%; min-height: 160px; display: flex; align-items: center; justify-content: center; padding: 16px;
  background: repeating-conic-gradient(var(--check-a) 0% 25%, var(--check-b) 0% 50%) 50% / 16px 16px;
}
.av-image img { max-width: 100%; max-height: 100%; object-fit: contain; image-rendering: auto; box-shadow: 0 0 0 1px var(--border); }
.av-overview { padding: 28px 24px; display: flex; flex-direction: column; gap: 14px; max-width: 560px; }
.av-overview .av-big { width: 40px; height: 40px; color: var(--archive); }
.av-overview .av-big .av-icon { width: 40px; height: 40px; stroke-width: 1; }
.av-overview h2 { margin: 0; font-size: 15px; }
.av-overview p { margin: 0; color: var(--muted-fg); }
.av-comment { margin: 0; padding: 8px 10px; border-radius: var(--radius); background: var(--muted); font: 11.5px/1.5 var(--mono-font); white-space: pre-wrap; overflow-wrap: anywhere; max-height: 200px; overflow: auto; }
.av-center { height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; padding: 24px; text-align: center; color: var(--muted-fg); }
.av-center h2 { margin: 0; font-size: 14px; color: var(--fg); }
.av-center p { margin: 0; max-width: 460px; }
.av-center .av-icon { width: 32px; height: 32px; stroke-width: 1; }
.av-spinner { width: 18px; height: 18px; border-radius: 50%; border: 2px solid var(--border); border-top-color: var(--fg); animation: av-spin .8s linear infinite; }
@keyframes av-spin { to { transform: rotate(360deg); } }
.av-toast {
  position: absolute; right: 14px; bottom: 14px; padding: 6px 10px; border-radius: var(--radius);
  background: var(--popover); color: var(--popover-fg); border: 1px solid var(--border);
  box-shadow: 0 4px 16px rgb(0 0 0 / .18); opacity: 0; transform: translateY(4px); transition: opacity .15s, transform .15s; pointer-events: none;
}
.av-toast.av-show { opacity: 1; transform: none; }
`

export function installStyles(): void {
  const style = document.createElement('style')
  style.textContent = css
  document.head.append(style)
}
