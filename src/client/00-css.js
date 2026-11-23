/**
 * The panel's stylesheet.
 *
 * Rendered as a React element inside the panel so unmounting removes it, and every
 * colour comes from a `--dsw-alias-*` theme token with a neutral fallback, so light
 * and dark follow the host instead of being pinned here.
 */
const DW_CSS = `
.dw-root {
  position: relative;
  isolation: isolate;
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  box-sizing: border-box;
  padding-top: var(--dsh-frame-top-clearance, 0px);
  background: var(--dsw-alias-bg-base, #1b1d21);
  color: var(--dsw-alias-label-primary, #e6e8ec);
  font-size: 13px;
  line-height: 1.45;
  font-family: var(--dsw-font-family, -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif);
  overflow: hidden;
}
.dw-root *, .dw-root *::before, .dw-root *::after { box-sizing: border-box; }
.dw-root button { font: inherit; color: inherit; }

.dw-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 38px;
  flex: 0 0 auto;
  padding: 0 10px;
  border-bottom: 1px solid var(--dsw-alias-border-l1, #2c2f36);
  background: var(--dsw-specific-sidebar-fill, var(--dsw-alias-bg-layer-1, #22242a));
}
.dw-toolbar-title {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
  flex: 1 1 auto;
}
.dw-toolbar-project {
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.dw-toolbar-path {
  color: var(--dsw-alias-label-secondary, #8b919d);
  font-size: 11.5px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  direction: rtl;
  text-align: left;
}
.dw-spacer { flex: 1 1 auto; }

.dw-project { position: relative; display: inline-flex; align-items: center; min-width: 0; }
.dw-project-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  max-width: 280px;
  height: 24px;
  padding: 0 6px;
  border: 1px solid transparent;
  border-radius: 6px;
  background: transparent;
  color: inherit;
  font-weight: 600;
  cursor: pointer;
}
.dw-project-btn:hover { background: var(--dsw-alias-bg-overlay, #2f333b); border-color: var(--dsw-alias-border-l1, #31353d); }
.dw-project-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dw-project-caret { opacity: .7; font-size: 10px; }
.dw-project-menu {
  position: absolute;
  top: 28px;
  left: 0;
  z-index: 40;
  min-width: 320px;
  max-width: 480px;
  max-height: 320px;
  overflow: auto;
  padding: 4px;
  border: 1px solid var(--dsw-alias-border-l1, #31353d);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-2, #262930);
  box-shadow: 0 10px 30px rgba(0, 0, 0, .45);
}
.dw-project-row {
  display: flex;
  flex-direction: column;
  gap: 1px;
  width: 100%;
  padding: 6px 8px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: inherit;
  text-align: left;
  cursor: pointer;
}
.dw-project-row:hover { background: var(--dsw-alias-bg-overlay, #2f333b); }
.dw-project-row.active { background: color-mix(in srgb, var(--dsw-alias-brand-primary, #4b8bf5) 18%, transparent); }
.dw-project-row-title { font-size: 12.5px; }
.dw-project-row-path { font-size: 11px; color: var(--dsw-alias-label-secondary, #8b919d); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dw-resizer { flex: 0 0 5px; align-self: stretch; cursor: col-resize; background: transparent; }
.dw-resizer:hover { background: color-mix(in srgb, var(--dsw-alias-brand-primary, #4b8bf5) 45%, transparent); }

.dw-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 26px;
  padding: 0 9px;
  border: 1px solid var(--dsw-alias-border-l1, #31353d);
  border-radius: 6px;
  background: var(--dsw-alias-bg-layer-2, #262930);
  color: var(--dsw-alias-label-primary, #e6e8ec);
  cursor: pointer;
  white-space: nowrap;
  font-size: 12px;
}
.dw-btn:hover { background: var(--dsw-alias-bg-overlay, #2f333b); border-color: var(--dsw-alias-border-l2, #3d424b); }
.dw-btn:disabled { opacity: .5; cursor: default; }
.dw-btn-accent {
  border-color: transparent;
  background: var(--dsw-alias-brand-primary, #4b8bf5);
  color: #fff;
  font-weight: 600;
}
.dw-btn-accent:hover { filter: brightness(1.08); background: var(--dsw-alias-brand-primary, #4b8bf5); }
.dw-btn-icon { width: 26px; padding: 0; justify-content: center; }
.dw-select {
  height: 26px;
  padding: 0 6px;
  border: 1px solid var(--dsw-alias-border-l1, #31353d);
  border-radius: 6px;
  background: var(--dsw-alias-bg-layer-2, #262930);
  color: var(--dsw-alias-label-primary, #e6e8ec);
  font: inherit;
  font-size: 12px;
  max-width: 150px;
}

.dw-body { display: flex; flex: 1 1 auto; min-height: 0; }

.dw-side {
  display: flex;
  flex-direction: column;
  width: var(--dw-side-width, 268px);
  flex: 0 0 auto;
  min-width: 0;
  border-right: 1px solid var(--dsw-alias-border-l1, #2c2f36);
  background: var(--dsw-specific-sidebar-fill, var(--dsw-alias-bg-layer-1, #22242a));
}
.dw-side-head {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 30px;
  flex: 0 0 auto;
  padding: 0 8px;
  border-bottom: 1px solid var(--dsw-alias-border-l1, #2c2f36);
  color: var(--dsw-alias-label-secondary, #8b919d);
  font-size: 11px;
  letter-spacing: .04em;
  text-transform: uppercase;
}
.dw-tree { flex: 1 1 auto; overflow: auto; padding: 4px 0 12px; }
.dw-node {
  display: flex;
  align-items: center;
  gap: 5px;
  height: 23px;
  padding: 0 8px 0 0;
  cursor: pointer;
  white-space: nowrap;
  color: var(--dsw-alias-label-primary, #e6e8ec);
  user-select: none;
}
.dw-node:hover { background: var(--dsw-alias-bg-overlay, #2b2f37); }
.dw-node-selected { background: color-mix(in srgb, var(--dsw-alias-brand-primary, #4b8bf5) 22%, transparent); }
.dw-node-selected:hover { background: color-mix(in srgb, var(--dsw-alias-brand-primary, #4b8bf5) 30%, transparent); }
.dw-node-twisty {
  width: 14px;
  height: 14px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  color: var(--dsw-alias-label-secondary, #8b919d);
}
.dw-node-twisty-empty { visibility: hidden; }
.dw-node-icon { flex: 0 0 auto; display: inline-flex; color: var(--dsw-alias-label-secondary, #8b919d); }
.dw-node-label { flex: 1 1 auto; min-width: 26px; overflow: hidden; text-overflow: ellipsis; font-size: 12.5px; }
.dw-node-detail {
  flex: 0 0 auto;
  max-width: 45%;
  padding-left: 8px;
  color: var(--dsw-alias-label-secondary, #8b919d);
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  flex: 0 1 auto;
}
.dw-node-env .dw-node-label { font-weight: 600; }
.dw-node-column .dw-node-label { font-size: 12px; }
.dw-node-column { height: 21px; }
.dw-node-more .dw-node-label { color: var(--dsw-alias-label-secondary, #8b919d); font-style: italic; }
.dw-node-error .dw-node-label { color: var(--dsw-alias-state-error-primary, #ef6b6b); }
.dw-node-more {
  margin-left: auto;
  width: 18px;
  height: 18px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: none;
  border-radius: 3px;
  background: transparent;
  color: var(--dsw-alias-label-secondary, #8b919d);
  cursor: pointer;
  opacity: .55;
}
.dw-node:hover .dw-node-more { opacity: 1; }
.dw-node-more:hover { background: var(--dsw-alias-bg-layer-2, #33373f); color: var(--dsw-alias-label-primary, #e6e8ec); }
.dw-node-retry .dw-node-label { color: var(--dsw-alias-state-warn-primary, #d9a23c); }
.dw-badge {
  margin-left: 6px;
  padding: 0 5px;
  height: 16px;
  line-height: 16px;
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-2, #2b2f37);
  color: var(--dsw-alias-label-secondary, #8b919d);
  font-size: 10.5px;
}

.dw-main { flex: 1 1 auto; display: flex; flex-direction: column; min-width: 0; min-height: 0; }

.dw-tabs {
  display: flex;
  align-items: stretch;
  height: 33px;
  flex: 0 0 auto;
  overflow-x: auto;
  overflow-y: hidden;
  border-bottom: 1px solid var(--dsw-alias-border-l1, #2c2f36);
  background: var(--dsw-alias-bg-layer-1, #22242a);
  scrollbar-width: thin;
}
.dw-tab {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 8px 0 10px;
  border: none;
  border-right: 1px solid var(--dsw-alias-border-l1, #2c2f36);
  background: transparent;
  color: var(--dsw-alias-label-secondary, #8b919d);
  cursor: pointer;
  font-size: 12px;
  white-space: nowrap;
  max-width: 220px;
}
.dw-tab:hover { background: var(--dsw-alias-bg-overlay, #2b2f37); color: var(--dsw-alias-label-primary, #e6e8ec); }
.dw-tab-active {
  color: var(--dsw-alias-label-primary, #e6e8ec);
  background: var(--dsw-alias-bg-base, #1b1d21);
  box-shadow: inset 0 2px 0 var(--dsw-alias-brand-primary, #4b8bf5);
}
.dw-tab-label { overflow: hidden; text-overflow: ellipsis; }
.dw-tab-close {
  width: 15px;
  height: 15px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 3px;
  border: none;
  background: transparent;
  color: inherit;
  cursor: pointer;
  opacity: .6;
  padding: 0;
}
.dw-tab-close:hover { background: var(--dsw-alias-bg-layer-2, #33373f); opacity: 1; }

.dw-editor-wrap {
  display: flex;
  flex-direction: column;
  flex: 0 0 auto;
  height: var(--dw-editor-height, 168px);
  min-height: 88px;
  border-bottom: 1px solid var(--dsw-alias-border-l1, #2c2f36);
}
.dw-editor-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 30px;
  flex: 0 0 auto;
  padding: 0 8px 0 10px;
  color: var(--dsw-alias-label-secondary, #8b919d);
  font-size: 11.5px;
  border-bottom: 1px solid var(--dsw-alias-border-l1, #2c2f36);
  background: var(--dsw-alias-bg-layer-1, #22242a);
}
.dw-editor {
  display: flex;
  flex: 1 1 auto;
  min-height: 0;
  background: var(--dsw-alias-bg-base, #1b1d21);
}
.dw-gutter {
  flex: 0 0 auto;
  /* The gutter is one string with newlines: without white-space pre it collapses. */
  white-space: pre;
  padding: 6px 6px 6px 10px;
  text-align: right;
  color: var(--dsw-alias-label-secondary, #6b7280);
  font-family: var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
  font-size: 12px;
  line-height: 19px;
  user-select: none;
  overflow: hidden;
  opacity: .75;
}
.dw-code {
  flex: 1 1 auto;
  min-width: 0;
  padding: 6px 10px;
  border: none;
  outline: none;
  resize: none;
  background: transparent;
  color: var(--dsw-alias-label-primary, #e6e8ec);
  font-family: var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
  font-size: 12.5px;
  line-height: 19px;
  white-space: pre;
  overflow: auto;
  tab-size: 2;
}
.dw-code::placeholder { color: var(--dsw-alias-label-secondary, #6b7280); }

/* SQL highlighting: the textarea stays the input surface; a pre behind it paints
   the same text with token colours. Both must use identical metrics. */
.dw-code-wrap { position: relative; flex: 1 1 auto; min-width: 0; display: flex; }
.dw-code-wrap .dw-code { position: relative; z-index: 1; color: transparent; caret-color: var(--dsw-alias-label-primary, #e6e8ec); background: transparent; }
.dw-code-wrap .dw-code::placeholder { color: var(--dsw-alias-label-secondary, #6b7280); }
.dw-code-highlight {
  position: absolute;
  inset: 0;
  margin: 0;
  padding: 6px 10px;
  overflow: hidden;
  white-space: pre;
  pointer-events: none;
  color: var(--dsw-alias-label-primary, #e6e8ec);
  font-family: var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
  font-size: 12.5px;
  line-height: 19px;
  tab-size: 2;
}
.dw-tok-keyword { color: #cf8e6d; font-weight: 600; }
.dw-tok-function { color: #56a8f5; }
.dw-tok-string { color: #6aab73; }
.dw-tok-number { color: #2aacb8; }
.dw-tok-comment { color: #7a7e85; font-style: italic; }
.dw-tok-literal { color: #c77dbb; }
.dw-tok-operator { color: #b3b8c2; }
.dw-tok-punct { color: var(--dsw-alias-label-secondary, #8b919d); }
.dw-complete {
  position: absolute;
  z-index: 60;
  min-width: 260px;
  max-width: 440px;
  max-height: 240px;
  overflow: auto;
  padding: 4px;
  border: 1px solid var(--dsw-alias-border-l1, #31353d);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-2, #262930);
  box-shadow: 0 12px 28px rgba(0, 0, 0, .45);
}
.dw-complete-row { display: flex; align-items: center; gap: 8px; padding: 4px 8px; border-radius: 6px; cursor: pointer; }
.dw-complete-row:hover, .dw-complete-row.active { background: var(--dsw-alias-bg-overlay, #2f333b); }
.dw-complete-row.active { outline: 1px solid color-mix(in srgb, var(--dsw-alias-brand-primary, #4b8bf5) 55%, transparent); }
.dw-complete-label { flex: 1 1 auto; font-family: var(--ds-font-family-code, ui-monospace, Menlo, monospace); font-size: 12px; }
.dw-complete-detail { flex: 0 1 auto; max-width: 170px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-alias-label-secondary, #8b919d); font-size: 10.5px; }
.dw-complete-kind { flex: 0 0 auto; color: var(--dsw-alias-label-secondary, #8b919d); font-size: 10px; opacity: .8; }

.dw-drag {
  height: 5px;
  flex: 0 0 auto;
  cursor: row-resize;
  background: transparent;
  border: none;
  padding: 0;
}
.dw-drag:hover { background: color-mix(in srgb, var(--dsw-alias-brand-primary, #4b8bf5) 40%, transparent); }
.dw-result { flex: 1 1 auto; display: flex; flex-direction: column; min-height: 0; }
.dw-result-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 28px;
  flex: 0 0 auto;
  padding: 0 10px;
  border-bottom: 1px solid var(--dsw-alias-border-l1, #2c2f36);
  background: var(--dsw-alias-bg-layer-1, #22242a);
  color: var(--dsw-alias-label-secondary, #8b919d);
  font-size: 11.5px;
}
.dw-result-body { flex: 1 1 auto; overflow: auto; min-height: 0; }
.dw-grid { border-collapse: separate; border-spacing: 0; font-size: 12px; width: max-content; min-width: 100%; }
.dw-grid th {
  position: sticky;
  top: 0;
  z-index: 2;
  background: var(--dsw-alias-bg-layer-2, #262930);
  color: var(--dsw-alias-label-primary, #e6e8ec);
  font-weight: 600;
  text-align: left;
  padding: 4px 10px;
  white-space: nowrap;
  border-bottom: 1px solid var(--dsw-alias-border-l2, #3d424b);
  border-right: 1px solid var(--dsw-alias-border-l1, #2c2f36);
  font-size: 11.5px;
}
.dw-grid th .dw-th-type {
  display: block;
  color: var(--dsw-alias-label-secondary, #8b919d);
  font-weight: 400;
  font-size: 10px;
}
.dw-grid td {
  padding: 3px 10px;
  white-space: pre;
  max-width: 460px;
  overflow: hidden;
  text-overflow: ellipsis;
  border-bottom: 1px solid var(--dsw-alias-border-l1, #23262c);
  border-right: 1px solid var(--dsw-alias-border-l1, #23262c);
  vertical-align: top;
}
.dw-grid tbody tr:nth-child(even) td { background: color-mix(in srgb, var(--dsw-alias-bg-layer-1, #22242a) 55%, transparent); }
.dw-grid tbody tr:hover td { background: color-mix(in srgb, var(--dsw-alias-brand-primary, #4b8bf5) 12%, transparent); }
.dw-grid .dw-cell-null { color: var(--dsw-alias-label-secondary, #6b7280); font-style: italic; }
.dw-grid .dw-rownum {
  position: sticky;
  left: 0;
  z-index: 1;
  background: var(--dsw-alias-bg-layer-2, #262930);
  color: var(--dsw-alias-label-secondary, #8b919d);
  text-align: right;
  font-variant-numeric: tabular-nums;
  min-width: 46px;
}
.dw-grid thead th.dw-rownum { z-index: 3; }

.dw-empty {
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 24px;
  color: var(--dsw-alias-label-secondary, #8b919d);
  text-align: center;
}
.dw-empty-title { font-size: 14px; color: var(--dsw-alias-label-primary, #e6e8ec); font-weight: 600; }
.dw-empty-hint { max-width: 560px; font-size: 12px; line-height: 1.7; }
.dw-code-block {
  max-width: 640px;
  max-height: 180px;
  overflow: auto;
  padding: 8px 10px;
  border-radius: 6px;
  border: 1px solid var(--dsw-alias-border-l1, #31353d);
  background: var(--dsw-alias-bg-layer-1, #22242a);
  color: var(--dsw-alias-label-secondary, #8b919d);
  font-family: var(--ds-font-family-code, ui-monospace, Menlo, monospace);
  font-size: 11px;
  text-align: left;
  white-space: pre-wrap;
  word-break: break-all;
}
.dw-error-text {
  color: var(--dsw-alias-state-error-primary, #ef6b6b);
  font-family: var(--ds-font-family-code, ui-monospace, Menlo, monospace);
  font-size: 11.5px;
  white-space: pre-wrap;
  word-break: break-word;
}

.dw-ddl { flex: 1 1 auto; display: flex; flex-direction: column; min-height: 0; }
.dw-ddl-body { flex: 1 1 auto; overflow: auto; margin: 0; padding: 10px 14px; }
.dw-ddl-body code {
  font-family: var(--ds-font-family-code, ui-monospace, Menlo, monospace);
  font-size: 12px;
  line-height: 1.65;
  white-space: pre;
  color: var(--dsw-alias-label-primary, #e6e8ec);
}

.dw-log {
  flex: 0 0 auto;
  height: var(--dw-log-height, 132px);
  transition: height 120ms ease;
  display: flex;
  flex-direction: column;
  border-top: 1px solid var(--dsw-alias-border-l1, #2c2f36);
  background: var(--dsw-alias-bg-layer-1, #22242a);
}
.dw-log-collapsed { height: 26px; }
.dw-rot-down { transform: rotate(90deg); }
.dw-log-collapsed .dw-log-body { display: none; }
.dw-log-toggle {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  border: none;
  background: transparent;
  color: inherit;
  cursor: pointer;
  font: inherit;
  letter-spacing: inherit;
  text-transform: inherit;
  padding: 0;
}
.dw-log-toggle:hover { color: var(--dsw-alias-label-primary, #e6e8ec); }
.dw-log-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 26px;
  flex: 0 0 auto;
  padding: 0 10px;
  border-bottom: 1px solid var(--dsw-alias-border-l1, #2c2f36);
  color: var(--dsw-alias-label-secondary, #8b919d);
  font-size: 11px;
  letter-spacing: .03em;
  text-transform: uppercase;
}
.dw-log-body {
  flex: 1 1 auto;
  overflow: auto;
  padding: 4px 10px 8px;
  font-family: var(--ds-font-family-code, ui-monospace, Menlo, monospace);
  font-size: 11.5px;
  line-height: 1.7;
}
.dw-log-line { white-space: pre-wrap; word-break: break-word; color: var(--dsw-alias-label-secondary, #8b919d); }
.dw-log-line b { color: var(--dsw-alias-label-primary, #e6e8ec); font-weight: 600; }
.dw-log-error { color: var(--dsw-alias-state-error-primary, #ef6b6b); }
.dw-log-ok { color: var(--dsw-alias-state-success-primary, #46b980); }
.dw-log-warn { color: var(--dsw-alias-state-warn-primary, #d9a23c); }

.dw-menu {
  position: fixed;
  z-index: 40;
  min-width: 190px;
  padding: 4px;
  border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-l2, #3d424b);
  background: var(--dsw-alias-bg-overlay, #23262d);
  box-shadow: 0 10px 26px rgba(0,0,0,.42);
}
.dw-menu-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 5px 8px;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: var(--dsw-alias-label-primary, #e6e8ec);
  cursor: pointer;
  font-size: 12px;
  text-align: left;
}
.dw-menu-item:hover { background: var(--dsw-alias-bg-layer-2, #33373f); }
.dw-menu-shortcut { margin-left: auto; color: var(--dsw-alias-label-secondary, #8b919d); font-size: 11px; }
.dw-backdrop { position: fixed; inset: 0; z-index: 39; }
.dw-splitter {
  width: 5px;
  flex: 0 0 auto;
  cursor: col-resize;
  background: transparent;
  border: none;
  padding: 0;
}
.dw-splitter:hover { background: color-mix(in srgb, var(--dsw-alias-brand-primary, #4b8bf5) 40%, transparent); }
.dw-spin { animation: dw-spin 900ms linear infinite; }
@keyframes dw-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
`

function DwStyles() {
  return h('style', { key: 'dw-style' }, DW_CSS)
}
