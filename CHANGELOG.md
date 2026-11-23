# Changelog

## Unreleased

### Fixed

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

### Added

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
