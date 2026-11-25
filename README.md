# dsh-data-window

A DataGrip-style database window for DeepSeek Harness. For a normal project it asks
for no connection at all: it reads the workspace's own Spring/Nacos configuration,
resolves each environment's host and credentials from the local Nacos snapshot
cache, and turns that into a browsable tree plus one read-only SQL workbench per
database. When a project's configuration cannot be resolved, a model or the user
can supply the connection — and either way it is proven with a real read-only
connection before it enters the tree.

## Features

- **Workspace-driven discovery** — `bootstrap.yml` → Nacos data-id → whichever
  data-id defines each `${…}` placeholder, resolved the way the JVM does it. No
  configuration file name is assumed. Only the data sources this project declares
  are shown; results are cached per workspace and refreshed when the files change.
- **AI fallback when the rules find nothing** — a workspace whose configuration
  shape the scan does not recognise can be analysed by a model configured in DSH.
  The model only proposes hosts and file/key paths; password values are redacted
  before they enter the prompt, the Host reads the secret itself, and every proposed
  address is proven with a real read-only connection before it joins an “AI” group
  in the tree. The model is chosen the first time (and changeable in settings).
- **Pick the databases to show** — the configured database is what the tree shows
  first; a per-instance picker (searchable checkboxes, configured ones locked on)
  chooses the other schemas, and the choice is remembered for that workspace.
- **Manual connections** — a toolbar button adds a host/port/account/database by
  hand for databases described nowhere in the workspace (a local container, a shared
  test instance). The form can import a connection another workspace already
  resolved — host, port, account and schema filled in, the password reused from the
  Host so it is never shown — because teams share one RDS endpoint across projects.
  The connection is tested before it is saved, entries are grouped by environment
  name (imported ones inherit the source's name; a manual environment can be renamed
  later), and the tree's context menu can remove one connection or delete the whole
  environment (re-importable from another workspace's data).
- **Explorer** — environments → instances → databases → tables → columns, with type,
  primary key, nullability and comment. One button reveals every schema on an
  instance, not only the configured ones. The column is draggable, and a
double-click on the divider restores its default width.
- **Editor with JetBrains-style colouring** — keywords, functions, strings, numbers and
  comments are highlighted; typing suggests tables, columns and keywords, `alias.`
  narrows to that table's columns; one click reindents the statement.
- **Create statement in one keystroke** — `F4` or `⌘/Ctrl + Shift + D` on a table.
- **One workbench per database**, kept as tabs, with a result grid, copy-as-TSV,
  a row limit, a draggable editor/result split and a collapsible run log. Opening a
  table's rows never overwrites SQL you already typed: a second console is added
  instead.
- **Read-only by construction** — verb whitelist, one statement per request, a
  write-keyword scan, and `SET SESSION TRANSACTION READ ONLY` on every pooled
  connection so the server refuses a write even if the static check is ever wrong.

## Install

```sh
cd dsh-data-window
npm install --omit=dev     # mysql2, the only runtime dependency
node build.mjs             # regenerate client.js from src/client/*.js
```

Then install the directory as a bundle (**Plugins → Add plugin**, or
`plugin_manager` `install_bundle` with this directory). The window opens from the
database button at the sidebar foot and renders as the main-column page keyed
`dsh-data-window:database`; `conversation.header.leading` is deliberately left
alone because another plugin already occupies that single seat.

- **Workspace chip** — the toolbar lists every workspace; picking one re-roots the
  window in place, without a trip through the sidebar.
- **Full width on entry** — entering the window folds the shell's navigation column;
  a toolbar button folds or unfolds it at any time.

## Shortcuts

| Key | Action |
|---|---|
| `⌘/Ctrl + Enter` | Run the statement in the active workbench (only the selection when there is one) |
| `⌘3` / `Ctrl+3` | Open the data window from anywhere (editable in settings) |
| `F4` / `⌘/Ctrl + Shift + D` | Show the selected table's create statement |
| `Tab` in the editor | Insert two spaces (or accept the highlighted suggestion) |
| `⌘/Ctrl + Space` | Open the suggestion list |
| `↑` / `↓`, `Esc` | Move through or dismiss suggestions |
| Format button | Reindent the statement |
| Double-click a table | Open its rows in a workbench |

The window follows the workspace the shell is showing. Picking a directory by hand
keeps that choice until **Follow the workspace** is pressed, and the choice survives
a reload.

## Configuration

Set these under the plugin row's `config` in `cordis.patch.yml`:

| Key | Default | Meaning |
|---|---|---|
| `nacosHome` | `~/nacos` | Root of the Nacos client's local cache |
| `groups` | all | Only read these Nacos groups, e.g. `[business]` |
| `envOrder` | `dev1, dev, qa2, qa1, …` | Environment order in the tree |
| `connectTimeoutMs` | `8000` | Connect timeout |
| `statementTimeoutMs` | `60000` | Per-statement timeout; `0` disables |
| `connectionLimit` | `4` | Pool size per target |
| `defaultLimit` | `200` | Default row limit |
| `cache` | `true` | `false` re-reads the configuration on every open |

## Limits

- MySQL / MariaDB only.
- Requires a local Nacos snapshot cache and the workspace's own `spring.datasource`
  configuration. A project without one, or one that has never started, shows an empty
  tree; the other data-ids in the snapshot are read only for the values the
  project's placeholders name. The optional AI fallback and manual connections can
  fill that gap; the AI path needs an LLM provider configured in DSH, and — like
  everything else — only keeps addresses that actually connect.
- Each workspace keeps its own discovery cache under
  `$DSH_HOME/storages/dsh-data-window/workspaces/` (mode `0600`). A file holds only
  that project's resolved hosts and credentials; deleting it forgets just that
  project.
- One instance per query; use `schema.table` for cross-schema reads.

## License

MIT
