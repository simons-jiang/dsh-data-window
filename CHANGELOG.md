# Changelog

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
  and every schema on an instance the project never configured.
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
  the host alias from `yunwei-db.yml` (`mysql8-master`).
- Column names were truncated to two characters because the `NOT NULL` badge and
  the type text competed for the row width; the badge moved into the tooltip.
- `TEXT` columns were labelled `BLOB` (the protocol reports both under one code; the
  character set now decides).
- A workspace picked by hand did not survive a reload when the shell detected a
  workspace: the stored choice was only applied when detection was empty.
- The environment row read `4 · 0`; it now reads `2 实例 · 2 库`.
- Discovery cache now invalidates on the payload generation (`CACHE_VERSION` 3).
