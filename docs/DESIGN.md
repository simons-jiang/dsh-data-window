# dsh-data-window 设计说明

> 记录"为什么这样做"，而不是"做了什么"。功能清单看 `README.md`，使用说明看 `docs/DETAIL.md`。
> 本文对应的版本：0.1.0。

---

## 1. 目标与约束

用户原话拆成四条功能 + 一条硬约束：

| # | 需求 | 本质难点 |
|---|---|---|
| 1 | 点工作区自动加载代码里的数据库配置，缓存；多环境各自缓存地址 | 配置不在仓库里，而在 Nacos 快照里，且是多级占位符引用 |
| 2 | 看到实例、库、表、表字段 | 元数据量大（单实例 174 库），必须懒加载 |
| 3 | 快捷键快速看建表语句 | 快捷键必须在"没有焦点"时也能拿到当前选中表 |
| 4 | 一项目多库，每库一个 SQL 工作台 | 标签页身份必须唯一且稳定 |
| — | 只做查询，不做更新 | 不能只靠正则拦，必须有服务端兜底 |

一个隐含约束：**不新增任何需要人工维护的连接配置**。用户要的是"打开项目就能查"，不是"再配一个 DataGrip"。

---

## 2. 关键洞察：配置链路的真相

最初以为"读 `application.yml` 里的 `spring.datasource`"就够了，实际读代码后发现是三级引用：

```
仓库 bootstrap.yml
  spring.application.name = demo-order-service      ← 应用身份
  nacos.config.server-addr = ${nacos.config-server:https://nacos-dev…}   ← 决定用哪套 nacos

本机 Nacos 快照
  ~/nacos/config/fixed-<server>-dev1_nacos/snapshot-tenant/dev1/${group}/demo-order-service
    spring.datasource.url      = jdbc:mysql://${yibuyun.dbs.mysql-master}/demo_order
    spring.datasource.username = ${yibuyun.dbs.demo_order_service.username}
    spring.datasource.password = ${yibuyun.dbs.demo_order_service.passwd}

  ~/nacos/config/…/dev1/${group}/yunwei-db.yml
    yibuyun.dbs.mysql-master = mysql.internal.example.com:3306          ← 主机别名 → 真实地址
    yibuyun.dbs.demo_order_service:
      username: app_user
      passwd: …                                                          ← 按"库名"给的凭据
```

三个由此而来的决定：

1. **必须实现一个 YAML 子集解析器**（`src/host/yaml.js`）。这些文件只有缩进映射、块列表、多文档、`#` 注释、引号标量，为四个功能拉一个完整 YAML 引擎不划算。明确不支持锚点/合并键/流式集合，并在文件头写明。
2. **必须在 Host 侧读文件系统**。浏览器拿不到 `~/nacos`。
3. **必须做占位符递归解析**（`${a.b:fallback}`），否则拿到的全是字面量。

另一个容易踩的坑：**同一个租户名会出现在多个 nacos 缓存里**。本机 12 个 `fixed-*_nacos` 目录，`dev1` 同时存在于 `nacos-dev`（业务）和 `nacos-other`（另一套集群）。如果按租户名合并，SCF 集群的主机会混进业务项目的树里。

解法：从项目自己的 `bootstrap.yml` 取 `server-addr`，**用主机名去匹配缓存目录名**，同名租户只取匹配的那个（`discovery.js: projectNacosServers` + `compareCandidates`）。匹配不到才退化成"解析出库最多的那个缓存"。

---

## 3. 整体架构：为什么这样切

```
┌──────────────────────── 浏览器（Client 插件）────────────────────────┐
│  main 槽位面板  dsh-data-window:database                            │
│   ├─ 左侧树（环境/实例/库/表/字段）                                 │
│   ├─ 标签页 + SQL 编辑器 + 结果表格 + 运行日志                       │
│   └─ store（useSyncExternalStore 唯一数据源）                        │
│         │ fetch POST /dsh-data/rpc  {action, …}                     │
└─────────┼───────────────────────────────────────────────────────────┘
          ▼
┌──────────────────────── Host 进程（cordis 插件）─────────────────────┐
│  index.js  路由 + connection.requestRejection 围栏                  │
│  rpc.js    DataController：action 分发 + 错误→HTTP                  │
│  discovery.js  bootstrap.yml → nacos → 环境/实例/库 + targets(Map)  │
│  mysql.js  DataGateway：连接池 + 只读校验 + 元数据/DDL              │
│  cache.js  按工作区缓存（指纹 + 版本，0600）                        │
└──────────────────────────────────────────────────────────────────────┘
```

### 为什么 Host 持有凭据

浏览器侧拿到的只有连接 id：

- 实例：`i:<hash>`（`i:` = instance）
- 库：`d:<hash>`，或 `i:<实例id>~<库名>`（"浏览全部库"发现的项目未配置的库）

Host 维护 `id → {host, port, user, password, database, env}` 的 Map，**响应里永远不含密码**。这样：

- 浏览器 devtools / 页面内存里没有明文密码；
- 前端换一次发现或刷新页面，不需要重新传凭据；
- 缓存文件可以整体视为"主机清单 + 账号"，不必再拆一份"前端可见/不可见"。

### 为什么不是两个插件

曾考虑 Host 只做发现、查询交给一个通用 MCP/工具。否决理由：连接生命周期（池、只读会话、超时）与"面板里点一下就要 100ms 内出结果"是同一件事，拆开只会让每次点击多一次序列化往返。

---

## 4. 数据模型与身份设计

```
Environment（env = nacos 租户名，如 dev1/qa2/uat3）
 └─ Instance（id = i:hash(env, host, port)）
     ├─ label  = 项目里用的别名（mysql-master），识别度最高
     ├─ detail = 真实 host:port
     └─ Database
         ├─ id = d:hash(env, host, port, user, schema)   ← 项目配置里声明的库
         └─ id = i:<实例id>~<schema>                     ← 实例上现查出来的库
```

**`env` 必须进 hash**。这是评审发现并修掉的 bug：`rm-example-instance` 这台 RDS 同时服务 qa1 和 uat3 的多个 schema。不带 env 时：
- 树里选中一个实例会同时高亮另一个环境的同名实例（节点 key 相同）；
- 展开一次，两个环境共用同一份 children；
- 工作台 tab id 跨环境串台。

**派生 id 的设计**：`i:<id>~<schema>` 由字符串推导，`DataGateway.targetOf` 在查不到时用 `~` 拆开、从实例目标继承凭据实时注册。好处是"浏览全部库"打开的 tab 在重新发现（targets 整表替换）之后依然可用，不需要前端重新拉一遍。

---

## 5. 发现算法

```
discover(root, {nacosHome, groups, envOrder}):
  appNames  = 扫仓库 bootstrap/bootstrap-*/application*.yml 取 spring.application.name
              找不到就用目录名（并记 warning: project-no-application-name）
  snapshots = ~/nacos/config/*/snapshot-tenant/<tenant>[/group] 与 …/snapshot[/group]
  servers   = 项目配置里 nacos.*.server-addr 的主机名

  for 每个 snapshot:
      vars = 合并该 tenant 下各 group 的 yunwei-db.yml（扁平化 dotted map）
      if vars 为空: skip
      candidate = {env, cache, serverMatch: 目录名含 servers 之一}
      for 每个 group、每个文件:
          if 文件名（去扩展名）∈ appNames 且含 jdbc:mysql:// 的 datasource:
              解析 url → host/port/schema；解析 username/password 占位符
              按 (host,port) 归并成实例，库挂到实例下
      若一个库都没解析到：退化成该环境 yunwei-db.yml 里声明的全部实例（可浏览模式）

  同名 env 的多个 candidate：serverMatch > 库多 > 目录名字典序

  过滤：已经解析出库的环境，丢掉没有库的实例（避免把无关集群列出来）
  排序：envOrder（默认 dev1/dev/qa2/qa1/uat/uat3/test/staging/prod）→ 名字
  产出 targets: Map<id, {host, port, user, password, database, env}>
```

"退化成声明实例"这一步是刻意的：`sqlWorkspace`、`杂项` 这种没有数据源配置的目录，如果什么都不显示，工具在这些工作区里就是废的。退化后仍能展开实例 → 拉全部库 → 查。

---

## 6. 只读的四层防线

单靠正则不可靠（`WITH … DELETE` 的前缀是 `WITH`，函数也能写数据），所以叠四层：

| 层 | 位置 | 作用 |
|---|---|---|
| 1 动词白名单 | `assertReadOnly` | 首词必须是 `select/with/show/desc/describe/explain/table` |
| 2 单语句 | `splitStatements`（正确跳过引号与注释） | 一次只允许一条，`SELECT 1; DROP …` 直接拒 |
| 3 写关键字扫描 | 同一个函数 | `select/with/table` 语句体内出现 `insert/update/delete/drop/alter/…`、`into outfile`、`for update` 一律拒；`show/desc/explain` 跳过扫描（`SHOW CREATE TABLE` 的 `create` 是合法的） |
| 4 会话只读 | `pool.on('connection')` | `SET SESSION TRANSACTION READ ONLY`，让 MySQL 自己拒绝写入 |

第 4 层是真正的兜底，已在 dev1 实测：即使绕过前三层，`UPDATE` 也会返回 `ER_CANT_EXECUTE_IN_READ_ONLY_TRANSACTION`。

配套的还有 `SET SESSION max_execution_time`（默认 60s）与 `LIMIT n+1` 取行——多取一行才知道"到底有没有被截断"，正好 `n` 行时误报截断比多取一行更糟。

---

## 7. 缓存与失效

- 位置：`$DSH_HOME/storages/dsh-data-window/discovery.json`，0600。
- 键：工作区绝对路径。
- 值：`{payload, targets[], fingerprintPaths[], fingerprint, version}`。
- 失效：**文件指纹**（每个读过的配置文件 + 每个环境的 `yunwei-db.yml`，取 mtime+size）+ **插件版本**。任一变化就重解析。
- 写入：临时文件 + `rename`，崩溃不会留下半截 JSON。

两个设计点值得记住：

1. `payload` 与 `targets` 分开存：`payload` 是给浏览器的（无密码），`targets` 是 Host 自己恢复连接用的（含密码）。缓存命中时把 `targets` 灌回 `DataGateway`。
2. 版本里带 package version 是补的：改过 id 生成规则后，旧缓存里的 id 语义已经变了，但文件指纹没变，于是会命中一份"语义过期"的缓存。把插件版本并进 cache version，升级即失效。

---

## 8. 客户端状态机与交互决策

### 单一 store

整个面板只有一个 `state` 对象 + `useSyncExternalStore`。理由：树、标签页、结果、日志互相牵连（打开库要展开树、运行要更新 tab），多份 state 会立刻不同步。

派生数据（可见行、网格）用 `useMemo` / `React.memo` 挂在**引用稳定的切片**上（`state.expanded`、`state.children`、`result.rows` 这些只在真变化时换新引用），所以输入 SQL 时不会重建两千个单元格。

### 工作区跟随

`main` 槽位拿不到"当前会话"（它不是会话页面），所以用 `shell.overlay` 里一个不渲染的 `DwTracker` 记住会话→工作区，面板订阅 store 里的 root。

三个状态：
- 默认：跟随 tracker 检测到的 root；
- 手动选择目录后进入 `manual`，不再被 tracker 覆盖，并在工具栏显示「手动选择」+「跟随工作区」按钮（否则一旦手动选错就回不去了）；
- 手动选择写 `localStorage`，重启后能回到原位。

### 标签页身份

- 一库一台：`sql:<dbId>`，重复点同一个库只切标签，不再开一个。
- 建表语句：`ddl:<dbId>:<table>`。
- **树上"看数据"不覆盖已有语句**：若目标工作台的 SQL 还不是空模板，就开 `sql:<dbId>:<seq>` 第二个标签（`store.seedStatement`），并在标题加序号。这是"会丢失用户输入"的操作，必须特殊处理。

### 快捷键

`F4` / `⌘⇧D` 用**捕获阶段**的 `globalThis` keydown 监听（面板挂载时装、卸载时卸），因为点击树之后焦点不在 textarea 上。只认 `selectedNode.kind === 'table' | 'view'`。

没做全局命令面板条目：DSH 的快捷键目录是给"编辑快捷键"对话框用的，和面板内快捷键不是一套东西，硬塞进去会和宿主行为打架（`dsh-ide-window` 也踩过并绕开了）。

### 只读被拦时的表达

Host 返回的是机器码（`write-keyword`、`read-only-violation`）。用户被这条硬约束拦住时最需要人话，所以客户端有 `dwExplainFailure`：code → 句子（"这个窗口只允许查询语句，写操作已被拦截"），原始 detail 放括号里。

---

## 9. 失败态设计

评审指出原来四种"空"共用一个文案，其中两种是**假话**（"没有发现数据库配置"其实是"过滤没匹配到"）。现在分开：

| 状态 | 判据 | 呈现 |
|---|---|---|
| 没有工作区 | `root === ''` | 说明怎么开始 + 选择工作区 |
| 有工作区但解析失败 | `phase === 'error'` | 显示错误原文 |
| 解析成功但一个库都没有 | `environments === []` / `databaseCount === 0` | 说明"这些环境来自 yunwei-db.yml，不是本项目的数据源"，并给"列出第一个实例的全部库"按钮 |
| 正常但没选库 | 有 tab 之前 | "选择一个数据库" + 操作提示 |

另外两条：
- **节点加载失败可重试**。原来把错误塞进 `children` 当假子行，导致该节点永远不再请求，只能重启；现在失败只记 `loadState='error'`，树里渲染一行"点此重试"，且"重新读取配置"会清空元数据缓存。
- **过滤不是二值匹配**。原来是"环境名不匹配就整棵跳过"，输入库名会让整棵树消失；现在是"节点或任一已加载后代命中则保留祖先"，并单独给"没有匹配 + 清空过滤"。

---

## 10. DSH 插件机制笔记（踩过的坑）

写第二个同类插件时才不会再踩：

1. **客户端产物必须是单文件**。浏览器模块表按包 id 一包一文件，所以 `src/client/*.js` 只是给人读的，`build.mjs` 拼成 `client.js`，包一层 `window.__ModuleLoader__.load({id, factory})`。`factory` 返回 `{inject:[…], apply}`。
2. **`inject` 不声明就不能读**。`ctx.locale` / `ctx.slots` 写进 `inject`；`layout`、`uiWorkspace` 这种可选服务用 `ctx.inject([...], scoped => …)` 存引用，否则运行时直接抛 `cannot get property "x" without inject`（而且会被 try/catch 吞成一行日志，表现为"按钮没反应"）。
3. **`conversation.header.leading` 是 single 槽位且已被 `dsh-ide-window` 占用**。往里注册会顶掉别人，所以这个插件只占 `sidebar.footer.action`（list，有 `wide` 属性）和 `main`（keyed）。
4. **Host 路由要自己围栏**：`ctx.get('connection').requestRejection(request)` 判一次，否则等于给局域网开了个查库接口。
5. **link 安装的依赖从包目录解析**，所以 `mysql2` 必须 `npm install` 在本目录，不能只靠 profile 的 node_modules。
6. **已安装的包再装同版本会被拒**（`already-installed`），换代码要 `remove_bundle` → `install_bundle`。
7. **界面渲染无法自验**：agent 侧浏览器打不开运行中的页面（401 / 需要启动令牌，规则也不允许去找令牌）。所以 UI 改动只能静态自证 + 交给人工确认。

---

## 11. 被否决的方案

| 方案 | 否决理由 |
|---|---|
| 用完整 YAML 库（js-yaml） | 只为读 4 类文件引入一个解析器与安全面；自写子集 120 行可控，且能明确拒绝不支持的结构 |
| 浏览器直连 MySQL（WebSocket/HTTP 隧道） | 密码必须进页面，且浏览器拿不到 `~/nacos` |
| 不用服务端只读，只靠前端禁用 | 绕过前端就是写库；只读是用户的硬约束，必须在服务端落地 |
| 把 SQL 工作台做成 rightbar 页面 | 结果表格需要整宽，rightbar 太窄；`main` 才是数据窗口该占的位置 |
| 每个库一个独立 `connection` | 174 个库 × 池 = 连接爆炸；按 (host,port,user,database) 池化，且只有打开过的库才建池 |
| 缓存里不存密码，每次现解析 | 每点一次展开都要重读整棵 nacos，且解析失败时体验退化；0600 + 与源文件同权限等级的缓存是等价取舍 |
| 发现结果只按 `env` 合并多个 nacos | 见第 2 节：会把另一套集群的主机混进来 |

---

## 12. 验证矩阵

| 项 | 方式 | 状态 |
|---|---|---|
| 配置解析（3 级引用、多缓存去重） | Node 直接跑 `discoverProject` | 已验（真实 nacos 缓存，4 环境） |
| 发现缓存命中/失效 | `DataController` 连续两次 discover | 已验（第二次 `cached=true`） |
| 实例/库/表/字段/DDL/查询 | 对着 dev1 `demo_order` 真跑 | 已验（174 库 / 65 表 / DDL / 33ms 查询） |
| 只读四层 | 构造 `UPDATE`、`SELECT 1; DROP`、`WITH … DELETE` | 已验（均被拒，且服务端也拒绝写） |
| 派生库 id（浏览全部库） | `databases` → 用返回 id 查 tables/query | 已验 |
| 行数截断判定 | `limit=2` 对恰好 2 行 / 3 行 | 已验（false / true） |
| 插件槽位注册 | `cordis_inspect_query` Slots | 已验（main + footer 均 active） |
| Host 路由存活与围栏 | 无令牌 POST 应得 403 自家 JSON | 已验 |
| **界面渲染 / 交互观感** | 人工在应用里看 | **未验**（agent 无法登录页面） |

---

## 13. 演进方向

按收益排序，供下一次会话直接接手：

1. **查询取消**：Host 侧给每次 `query` 发 queryId，`action: 'cancel'` 时 `connection.destroy()`；客户端运行按钮变"停止"。
2. **结果导出 CSV / 单元格复制**：TSV 复制已有，CSV 只是编码差异。
3. **执行计划**：`EXPLAIN` 已在白名单里，缺一个"对当前语句执行 EXPLAIN"的入口与结果渲染。
4. **编辑器渲染优化**：输入仍然整 store patch，大结果下可感知；可把 SQL 文本放到组件本地 state + 防抖回写。
5. **多语句脚本**：现在严格单语句；可做"选中什么跑什么"的脚本执行（逐条串行 + 汇总结果）。
6. **表数据分页**：双击表固定 `LIMIT 100`，可以加 offset 翻页。
