# Changelog

## Unreleased

### Fixed

- Paging a `LIMIT` statement no longer fails with `ER_PARSE_ERROR`: the Host's row
  cap only recognised `LIMIT n` / `LIMIT m, n`, so a paged `… LIMIT n OFFSET m` got
  a second `LIMIT n+1` appended. All trailing limit forms are now left alone.
- Switching workspace now expands the shared tree down to that workspace's
  instances, so its databases are visible without two manual clicks; the Host's
  `focus` already carried instance ids, but the panel only used the environment ids.
- The `数据窗口` control in the sidebar foot no longer reads as permanently selected.
  DSH paints the selected panel on its own navigation rows and expects a footer
  occupant to bring hover chrome only; the filled toolbar button this control reused
  (white pill with a border in the light palette) therefore looked like a chosen row
  at all times. It now sits transparent beside the code workspace's control, and the
  highlight appears only while the data window is the open panel.
- The total-row `COUNT(*)` drops the statement's outermost `LIMIT` (limits inside
  subqueries are kept), so it counts the whole result set instead of echoing the
  preview size back.
- The suggestion list follows the keyboard: moving the highlight with ↑/↓ scrolls the
  popup so the selected column never slides out of view.
- Completion resolves quoted table names in `db`.`table` form, so columns of a
  backtick-quoted table are suggested (they used to be dropped because the table
  name kept its leading backtick).
- The SQL completion list appears as soon as the schema map arrives. Typing right
  after opening a workbench used to beat the map request, so the list stayed closed
  until the next keystroke.
- Placeholder resolution now understands nested defaults (`${new.name:${old.name}}`),
  which projects use when a service or data-id was renamed. The first `}` used to end
  the placeholder, so the resolved user kept a trailing `}` and the password one more
  character, and every query failed with `Access denied` even though the configuration
  was correct.

### Fixed

- INSERT export stays limited to single-table SELECT; a join is not made to guess a
  target table. Refusing now opens a dialog explaining why (it used to only append a
  log line, so clicking the menu item looked like nothing happened).
- Result cells are one fixed-height line with an ellipsis instead of growing to fit
  a long value; double-clicking a cell opens a detail dialog with the full text,
  copy and an edit action (editing moved from double-click to the context menu).

### Added

- The SQL editor now owns its context menu (undo, redo, cut, copy, paste, select all)
  and adds “AI optimize SQL”: the selection or whole statement is sent to the model
  chosen in settings, and the suggestion opens in a dialog that can copy it. The
  statement is never executed or written back to the editor. The explanation comes
  back in the window's language (the document language, falling back to the system
  locale).
- Right-click “刷新结构” on a connection, database or table/view re-reads that
  node's structure: the connection re-runs discovery, a database re-fetches its
  tables (and invalidates the editor's completion map), a table re-fetches its
  columns and refreshes its open DDL tab.
- The result bar's clipboard copy was replaced by “Export”: the current page (local
  cell edits included) can be saved as an XLSX workbook (built in the client, no
  dependency), a UTF-8 CSV, or an INSERT script. The save location is chosen through
  the File System Access API when available, otherwise the file is downloaded; the
  INSERT option requires a single-table SELECT.
- Result cells can be edited locally (double-click; Enter commits, Esc cancels) and
  edited cells are highlighted. Right-clicking a cell copies a single-row `UPDATE`
  built from the edited columns and the original primary key — the statement is never
  executed, and it is refused for non-single-table statements or results without a
  primary-key column. The “N edited” badge also has a copy button that copies one
  UPDATE per edited row in result order. Drafts reset when the result or page changes.
- Results paging for statements with a trailing `LIMIT`: the result bar shows
  previous/next controls, the page size is the statement's own limit (`LIMIT n`,
  `LIMIT n OFFSET m` and `LIMIT m, n` all parse; a subquery limit does not count),
  and a next page is run as a derived `… LIMIT n OFFSET m` statement without
  rewriting the editor. A next page that returns no rows ends the paging in place and
  disables “next”, leaving “previous” available; the total-row count still comes from
  the original statement.
- The resource tree is now shared by every workspace: opening a workspace adds its
  environments to the one tree (and expands them) instead of replacing it. Manual
  connections and picked databases moved to machine-wide files
  (`manual/connections.json`, `remembered/databases.json`); the old per-workspace
  documents are merged once and renamed `*.migrated`. Console snapshots and the
  discovery cache stay per workspace, and target ids are unchanged, so saved tabs
  keep working.
- The instance row opens a **database picker** instead of dumping every schema into
  the tree: a searchable checkbox list where the configured databases are locked on,
  and only checked schemas appear. The selection is remembered per workspace
  (instance id + schema name, 0600) and reappears on the next open; the schema reuses
  the instance's credentials, so no second copy of a password exists.
- Manually added connections: a toolbar button opens a small form (environment name,
  host, port, user, password, optional database) for databases described nowhere in
  the workspace. The Host proves the connection with a read-only `SELECT VERSION()`
  before saving it, keeps the entries in a 0600 file per workspace, groups them by
  environment name, and offers “Remove this connection” in the tree's context menu.
  The form can also import a connection that any workspace on this machine already
  resolved or added: host, port, account and schema are filled in, and the password
  is reused from the Host store (looked up by source id at save time) instead of
  being shown or retyped. Importing also fills the environment name from the saved
  connection, and a manual environment can be renamed from the tree — the databases
  already picked for it move with the new name instead of being stranded. A manual
  environment can also be deleted as a whole (with a confirmation): its connections,
  picked databases and pools go away, and it stays out of the tree until the
  connection is imported again from another workspace.
- An optional AI fallback for workspaces whose configuration shape the rule-based
  scan does not recognise. The model (chosen the first time it is needed, from the
  providers configured in DSH, and changeable in settings) only points at files and
  key paths; password values are redacted before the prompt, the Host reads the
  secret itself inside the workspace, and each proposed address is proven with a
  read-only connection before it joins an “AI” group in the tree. Failures are
  reported in the run log instead of leaving broken entries behind.
- The data window answers the code workspace's bridge: `openTable` opens/focuses a
  table's console, resolves the owning database through `findTable`, and runs the
  base query; `openSql` pastes a mapper statement without running it. The contract
  is versioned and documented in `docs/BRIDGE.md`.
- The settings page has a dedicated **Shortcuts** group. The open shortcut is
  editable (record a new combination, reset to ⌘3 / Ctrl+3) and stored per browser.
- The data window follows the palette chosen in `dsh-ide-window` through the same
  `dsh-theme` contract `dsh-git-window` uses; with no theme chosen it keeps DSH's
  colours.
- The run log records every executed statement, including the `COUNT(*)` the total-row
  refresh runs.
- The result bar shows a total-row counter: the refresh button next to it runs one
  `COUNT(*)` for the statement that produced the result.
- The plugin has its own page in DSH's settings (`数据窗口`): auto-fold the sidebar,
  the default row limit, the shortcut and the console snapshot path.
- `⌘3` / `Ctrl+3` opens the data window from anywhere.
- Workbench SQL is kept per workspace in a Host file
  (`<workspace>/workspaces/<hash>-<name>.consoles.json`, mode 0600): switching to
  another workspace, reloading the window or restarting DSH restores the console
  with its text. Closing a tab deletes its snapshot; results are never restored.
- Running with a selection executes **only the selected statement** (⌘/Ctrl+Enter or
  the Run button); running the whole buffer while a fragment was selected used to
  send several statements and end in a confusing `ER_PARSE_ERROR`.
- The window is titled **Data window / 数据窗口** (it used to read “database data
  window”).
- A workspace chip in the toolbar lists every known workspace and re-roots the window
  in place, without a trip through the sidebar.
- The explorer column is draggable; a double-click on the divider restores the
  default width.
- Entering the window folds the shell's navigation column, and a toolbar button folds
  or unfolds it at any time.

- The SQL editor highlights keywords, functions, strings, numbers and comments, and
  suggests tables, columns and keywords from a schema map the Host reads once per
  database (`alias.` narrows to that table's columns).
- A **Format** button reindents the statement: clause keywords on their own line, one
  select item per line, joins and boolean operators indented; keyword case is kept.

### Changed

- The “跟随工作区” and “选择工作区” toolbar buttons are gone: the workspace is
  chosen in the shell's own top-left control, and the project chip menu keeps a
  “跟随工作区” row so a manually picked directory can still return to following the
  shell.
- “AI 分析” and “添加连接” moved from the top toolbar into the resource explorer
  header: both act on the tree, not on the workspace, and the toolbar keeps only
  workspace-level actions.
- Each table has its own console tab (`sql:<dbId>:tbl:<table>`). Double-clicking a
  table opens or focuses that tab and appends one base statement at the bottom;
  numbered copies no longer pile up and existing text is never replaced. Only the
  appended statement runs, so repeating the double-click cannot send several
  statements in one request.

- Discovery no longer hard-codes the data-id that carries hosts and passwords.
  Every YAML data-id in the snapshot is a candidate, and only the files that define
  a `${…}` key referenced by the project's own datasource are read; the project's
  own values win over shared ones. Data-ids are accepted with or without the `.yml`
  suffix (Nacos stores both), and an instance alias now comes from the project's own
  URL template (`${acme.dbs.mysql-main}` → `mysql-main`) instead of the
  fixed `<namespace>.dbs.<alias>` shape.
- Discovery now returns only the instances and databases the workspace's own
  `spring.datasource` entries name. `yunwei-db.yml` is still read to resolve the
  placeholders and to label a host with its alias, but the hosts it declares on its
  own no longer reach the tree: they belong to other projects and the viewer has no
  account for them, so browsing them only produced `Access denied` and
  `ENOTFOUND` for a short host name that only resolves inside the cluster.
- The empty state explains that only this project's data sources are read; the
  "list every database on the first instance" fallback button is gone with it.
- The discovery cache is now one file per workspace under
  `storages/dsh-data-window/workspaces/` instead of a single `discovery.json` that
  held every project's resolved hosts and credentials. Deleting a project's file
  forgets only that project, a corrupt file cannot affect the others, and the old
  shared file is removed on startup.
- An empty discovery result is no longer cached, so a service that starts (or a
  datasource that is added) shows up on the next open instead of needing a reload.
- `docs/screenshots/` retaken against a neutral `demo-shop` workspace (system schema
  through a local forwarder): no real host, business database, table or person is
  visible in the images.

## 0.1.0

First version.

### Host

- Workspace configuration discovery: `bootstrap.yml` → `spring.application.name` →
  the matching Nacos data-id → `yunwei-db.yml` for hosts and credentials, resolved
  the way the JVM resolves the placeholders.
- Several Nacos caches may hold a tenant with the same name; the cache the project's
  own `server-addr` points at wins, so another cluster's hosts never leak in.
- Per-workspace discovery cache (`$DSH_HOME/storages/dsh-data-window`, mode `0600`)
  keyed by a fingerprint of every file it read and by the plugin version.
- Read-only MySQL gateway: verb whitelist, one statement per request, a
  write-keyword scan, and `SET SESSION TRANSACTION READ ONLY` on every pooled
  connection, so the server refuses a write even if the static check is wrong.
- `SHOW DATABASES`, `information_schema` table/column metadata, `SHOW CREATE TABLE`,
  and every schema on a listed instance, not only the configured ones.
- Connection ids carry the environment, because one RDS host serves several tenants.

### Client

- DataGrip-style main-column window: explorer tree, one workbench tab per database,
  result grid, draggable editor/result split and a collapsible run log.
- `F4` / `⌘/Ctrl + Shift + D` opens the selected table's create statement; the DDL
  document can be refreshed without closing it.
- Table rows open in the workbench without overwriting SQL the user already typed:
  a second console is added instead.
- The window follows the workspace the shell shows; a manual directory pick is kept
  until "Follow the workspace" is pressed and survives a reload.
- Zero-environment, zero-configuration, failed-discovery and failed-node states each
  say what happened and offer the next step; a failed node is retryable.
- Host error codes are rendered as sentences, with the original detail in brackets.

### Verified in the running application

The panel was driven end to end in a real browser (CDP, real mouse and keyboard
events): open from the sidebar, expand an environment and an instance, open the
`demo_order` workbench (65 tables), run `SELECT * FROM demo_api_log
LIMIT 5` (5 rows, 63 ms), press F4 on a table for its create statement. No console
errors. Two screenshots in `docs/screenshots/`.

Fixes found by that pass:

- The instance row showed the configuration path (`spring.datasource`) instead of
  the host alias from `yunwei-db.yml` (`mysql-main`).
- Column names were truncated to two characters because the `NOT NULL` badge and
  the type text competed for the row width; the badge moved into the tooltip.
- `TEXT` columns were labelled `BLOB` (the protocol reports both under one code; the
  character set now decides).
- A workspace picked by hand did not survive a reload when the shell detected a
  workspace: the stored choice was only applied when detection was empty.
- The environment row read `4 · 0`; it now reads `2 实例 · 2 库`.
- Discovery cache now invalidates on the payload generation (`CACHE_VERSION` 3).
