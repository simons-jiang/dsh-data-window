# 与代码工作区的联动契约

`dsh-data-window` 提供能力，`dsh-ide-window` 调用。两个客户端 bundle 不能互相 import，所以用**窗口事件**通信——和 `dsh-theme` 主题契约同一风格。本文是契约的唯一权威版本；代码工作区仓库的改动以这里为准。

## 能力标记

数据窗口插件激活时设置：

```js
window.__DSH_DATA_WINDOW_BRIDGE__ = { v: 1 }
```

代码工作区在渲染菜单前检查 `v === 1`；没有标记就不显示菜单项。插件卸载时删除标记。

## 请求

```js
window.dispatchEvent(new CustomEvent('dsh-data-window:request', {
  detail: {
    v: 1,
    id: crypto.randomUUID(),
    action: 'openTable' | 'openSql',
    root: '/absolute/workspace/path',
    // openTable
    schema: 'bw_order',        // @TableName("schema.table") 时有
    table: 'after_sale_order',
    // openSql
    sql: 'select ...',
    title: 'PurchaseOrderMapper.countGroupByStatus',
  },
}))
```

- `root` 必须是绝对路径；数据窗口会**永久切换**到该工作区（和手动切换工作区一致）。
- `openTable`：定位表所在库，打开/聚焦该表的专属标签，追加并**执行**一条基础查询 `SELECT * FROM \`schema\`.\`table\` LIMIT 100`。
- `openSql`：打开/聚焦以 `title` 命名的标签，把 SQL **粘贴**进编辑器并聚焦；不自动执行（Mapper SQL 通常带 `#{...}` 与动态片段）。
- 请求串行处理，避免工作区切换与发现过程互相竞争。

## 回执

```js
window.dispatchEvent(new CustomEvent('dsh-data-window:response', {
  detail: {
    v: 1,
    id,                 // 与请求一致
    action,
    ok: true,
    database: 'bw_order',
    env: 'dev1',
    instanceLabel: '…:3306',
    tabId: 'sql:d:…:tbl:after_sale_order',
    candidates: [{ dbId, database, env, envLabel, instanceLabel }],
  },
}))
```

失败时 `ok: false`，`reason` 为机器码：

| reason | 含义 |
|---|---|
| `unsupported-version` | `v` 不是 1 |
| `invalid-root` / `invalid-table` / `empty-sql` | 请求字段不合法 |
| `workspace-timeout` / `discovery-failed` | 工作区发现未完成或失败 |
| `no-datasource` | 工作区没有解析到数据源 |
| `table-not-found` | 所有已配置库里都没有这张表 |
| `query-failed` | 基础查询执行失败（`error` 带原始信息） |
| `unknown-action` / `timeout` | 未知动作 / 调用方等待超时 |

请求方按 `id` 匹配回执；建议 2s 超时，超时按“数据窗口未响应”提示。

## 库的定位

1. `@TableName("schema.table")` 带 schema → 直接用；
2. 否则调用 Host `findTable({ root, table, schema? })`，只在项目已配置的库里查 `information_schema.TABLES`，返回候选；
3. 多个候选时按**环境顺序取第一个**，回执里带全部 `candidates`，调用方可提示用户；
4. 没有候选 → `table-not-found`。

`openSql` 不查表，按这条顺序选库：

1. 请求带了 `schema` → 精确匹配该库；
2. 否则**只在本工作区发现出来的库**里取第一个（资源树是全机共享的，同一个实例下还挂着别的项目的库；`shared.js` 会给本项目发现的库打 `inWorkspace: true`）；
3. 本工作区一个库都没发现（比如只有共享/手动连接）→ 退回全量列表的第一个。

## 只读边界

桥只负责打开控制台、粘贴文本、执行生成的只读 `SELECT`。所有真正发往 MySQL 的语句仍然经过 Host 的只读网关（白名单 / 单语句 / 写关键字 / `SET SESSION TRANSACTION READ ONLY`）。`openSql` 从不自动执行外部传入的 SQL。

## 添加动作

1. 在 `src/client/07-bridge.js` 的 `dwBridgeHandle` 加分支；
2. 请求/回执字段只增不改，保持 `v: 1`；破坏性变更升 `v` 并在代码工作区侧做兼容；
3. 更新本文和 `CHANGELOG.md`。

## 手工验证

```js
window.addEventListener('dsh-data-window:response', (event) => console.log(event.detail))
window.dispatchEvent(new CustomEvent('dsh-data-window:request', {
  detail: {
    v: 1, id: 'probe', action: 'openTable',
    root: '/path/to/workspace', schema: 'bw_order', table: 'after_sale_order',
  },
}))
```

`openTable` 的成功回执应包含 `ok: true`、`database`、`tabId`，并且数据窗口已打开该表标签。
