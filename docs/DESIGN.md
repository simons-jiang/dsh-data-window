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
    spring.datasource.url      = jdbc:mysql://${acme.dbs.mysql-master}/demo_order
    spring.datasource.username = ${acme.dbs.demo_order_service.username}
    spring.datasource.password = ${acme.dbs.demo_order_service.passwd}

  ~/nacos/config/…/dev1/${group}/<定义这些变量的 data-id>（示例 yunwei-db.yml，名字由项目决定）
    acme.dbs.mysql-master = mysql.internal.example.com:3306          ← 主机别名 → 真实地址
    acme.dbs.demo_order_service:
      username: app_user
      passwd: …                                                          ← 按"库名"给的凭据
```

三个由此而来的决定：

1. **必须实现一个 YAML 子集解析器**（`src/host/yaml.js`）。这些文件只有缩进映射、块列表、多文档、`#` 注释、引号标量，为四个功能拉一个完整 YAML 引擎不划算。明确不支持锚点/合并键/流式集合，并在文件头写明。
2. **必须在 Host 侧读文件系统**。浏览器拿不到 `~/nacos`。
3. **必须做占位符递归解析**（`${a.b:fallback}`），否则拿到的全是字面量。

解析器还有一个容易漏的细节：**默认值里可以再嵌套占位符**（`${acme.dbs.new_app.username:${acme.dbs.old_app.username}}`，项目改名时的常见写法）。按"第一个 `}`"截断会得到 `dev_user}` 和尾随一个字符的密码，登录直接 `Access denied`；`yaml.js` 现在按嵌套计数找结束花括号，并对默认值继续递归解析。

另一个容易踩的坑：**同一个租户名会出现在多个 nacos 缓存里**。本机 12 个 `fixed-*_nacos` 目录，`dev1` 同时存在于 `nacos-dev`（业务）和 `nacos-other`（另一套集群）。如果按租户名合并，另一套集群的主机会混进业务项目的树里。

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
│  cache.js  每个工作区一份缓存（指纹 + 版本，0600）                  │
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
      projectFiles = 该 tenant 下 data-id ∈ appNames 的文件（带不带 .yml 都认）
      if projectFiles 没有任何 datasource: skip
      needed = 这些 datasource 的 url/username/password 里引用的 ${…} 键
      vars = {}
      反复扫描同 group 的其它 data-id（同组优先）：
          合并"定义了 needed 中某个键"的文件（扁平化 dotted map），
          并把它值里新出现的 ${…} 键加入 needed，直到不再有新文件命中
      项目自己 data-id 里的变量也参与解析（自包含的项目无需外部文件）
      candidate = {env, cache, serverMatch: 目录名含 servers 之一}
      对每个 datasource:
          用 vars 解析 url → host/port/schema；解析 username/password
          按 (host,port) 归并成实例，库挂到实例下
          实例别名 = 项目 URL 模板里那个占位符的最后一段（`${a.b.mysql-main}` → `mysql-main`）
      没有项目 datasource 指向的实例不进树

  同名 env 的多个 candidate：serverMatch > 库多 > 目录名字典序

  过滤：只保留库数 > 0 的实例；一个实例都没有的环境整条丢掉
  排序：envOrder（默认 dev1/dev/qa2/qa1/uat/uat3/test/staging/prod）→ 名字
  产出 targets: Map<id, {host, port, user, password, database, env}>
```

早期为了照顾 `sqlWorkspace`、`杂项` 这类没有数据源配置的目录，这里还会退化成列出快照里声明的全部实例。**这一版删掉了**：那些实例属于别的项目，账号也对不上——实测出现 `Access denied`（把共享文件里最常用的账号套到另一套实例上）和 `ENOTFOUND`（另一套集群里只在内网可解析的短名），树里还混进另一套集群的主机。现在工作区没有本项目数据源就什么都不列，空状态说明原因；某个实例上还有哪些库，用已列出的实例行上的「列出全部库」。

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

- 位置：`$DSH_HOME/storages/dsh-data-window/workspaces/<hash>-<目录名>.json`，0600，**一个工作区一份**。
- 键：文件内的 `root` 是工作区绝对路径；文件名用路径 hash 保证唯一，目录名只是方便人看。
- 值：`{version, root, at, payload, targets[], fingerprintPaths[], fingerprint}`。
- 失效：**文件指纹**（每个读过的配置文件，含定义占位符的那些 data-id，取 mtime+size）+ **插件版本**。任一变化就重解析。
- 写入：临时文件 + `rename`，崩溃不会留下半截 JSON。

**为什么不是一份大文件**：所有项目的账号密码会挤在同一个文件里（一份泄露等于全泄露），一个坏文件连累全部，"忘记某个项目"也做不到；并发写入还要整表重写。旧版的 `discovery.json` 在插件启动时直接删除（它只是缓存，删掉最多重新解析一次）。

两个设计点值得记住：

1. `payload` 与 `targets` 分开存：`payload` 是给浏览器的（无密码），`targets` 是 Host 自己恢复连接用的（含密码）。缓存命中时把 `targets` 灌回 `DataGateway`。
2. 版本里带 package version 是补的：改过 id 生成规则后，旧缓存里的 id 语义已经变了，但文件指纹没变，于是会命中一份"语义过期"的缓存。把插件版本并进 cache version，升级即失效。

---

## 8. 客户端状态机与交互决策

### 单一 store

整个面板只有一个 `state` 对象 + `useSyncExternalStore`。理由：树、标签页、结果、日志互相牵连（打开库要展开树、运行要更新 tab），多份 state 会立刻不同步。

派生数据（可见行、网格）用 `useMemo` / `React.memo` 挂在**引用稳定的切片**上（`state.expanded`、`state.children`、`result.rows` 这些只在真变化时换新引用），所以输入 SQL 时不会重建两千个单元格。

### 窗口内切换工作区

标题栏的 chip 从 `useWorkspaces` 的快照里取全部工作区（名称 + 路径），选中后调用 `store.setManualRoot(path)`，**只把窗口重新生根，不去选 Session**：选 Session 会把主栏交给对话页，等于把用户踢出数据窗口。因此 chip 切换后的状态是“手动选择”，要回到跟随 Shell 再点「跟随工作区」。

### 折叠侧栏与列表宽度

- `layout.toggleSidebar()` 是个裸开关，没有可读状态；能判断的只有 frame 上的 `data-sidebar-collapsed`。进入窗口时收起（仅宽屏，窄于 1024 时这个开关翻的是抽屉而不是列），离开时只在仍然收起的情况下展开，工具栏再给一个手动开关兜底。
- 资源管理器宽度存在 `localStorage`（`dsh-data-window:side-width`）：它是阅读偏好，不属于项目事实；拖动时夹在 200px、720px 与“面板宽度 - 360px”之间，双击恢复 268px。

### SQL 编辑器

- **高亮不改输入层**。编辑器仍是 textarea：输入法、选区、撤销、快捷键都是浏览器自带的。高亮是一层 `<pre>`，字形、行高、内边距与 textarea 完全一致，文字透明、只留光标；滚动时把 `scrollTop/scrollLeft` 同步过去。这样不必自造编辑器，也不会和输入法打架。
- **提示数据来自 Host 的一次读取**。新增 `schema` action：一次 `information_schema.COLUMNS` 查询拿到整库的表与字段，客户端按库缓存；`FROM/JOIN` 的别名从 SQL 里解析，`别名.` 直接筛该表字段。没有结构数据时退化为关键字，不让提示失败影响输入。
- **格式化不引第三方**。客户端产物是拼接出来的单文件，装不了 npm 包，所以格式化器自己写：复用同一个词法器的 token，只在子句关键字、select 列表逗号、join/and 处换行并缩进，**不改变关键字大小写**（和 DataGrip 的默认行为一致）。

### 每张表一个控制台

双击表生成的 `SELECT * … LIMIT n` 写进该表自己的标签（`sql:<dbId>:tbl:<table>`），标签名就是表名。重复双击同一张表只聚焦这个标签，并在末尾追加一条新的基础查询（空行分隔），不会新建编号副本，也不会替换用户已经写下的内容；一个工作区里同一张表永远只有一个文件。追加后只执行刚追加的那条语句，绝不把整个文件当一条语句发出去——否则两条 SELECT 会直接触发 `ER_PARSE_ERROR`。点击库名打开的通用工作台仍然保留，用于自己写语句。

### 设置页与快捷键

设置页是 `settings.section` 槽位，所以它在 DSH 设置左侧拿到独立的一行（和「代码工作区」并列），而不是塞进通用设置。页面里的选项都是**显示偏好**（进入时是否收起侧栏、默认行数上限、快捷键说明、快照路径），存在浏览器里；项目数据（数据源、语句）仍然各归各的工作区文件。

快捷键 `⌘3` / `Ctrl+3` 没走 DSH 的快捷键目录，而是在窗口捕获阶段监听 `Digit3` + 主修饰键，再调用 `layout.selectPanel` 打开面板——和代码工作区绑定自己的面板是同一做法，这样在窗口还没打开时也能用。

### 主题联动与快捷键

配色**不在本插件里选**：`dsh-ide-window` 是主题的所有者，它把选择发布成三个字符串——`localStorage['dsh-theme']`、`dsh-theme` window 事件、`<link id="dsh-theme-link">` 指向的 `/dsh-ide/theme?id=<id>` 样式表（样式只作用于 `[data-dsh-theme="<id>"]`）。本插件按 `dsh-git-window` 的同一套契约做**跟随者**：读取 id、把属性设在 `.dw-root` 上、监听事件即时换肤；id 为空就移除属性，回到 DSH 的 token。这样在代码工作区切主题，数据窗口立刻跟着变，不需要在这里再维护一份配色。

快捷键由一个注册表描述（`{ code, modifiers }`），默认 ⌘3 / Ctrl+3；设置页的「快捷键」组按注册表渲染，可录制新组合、可恢复默认，绑定存在浏览器偏好里。窗口级监听在捕获阶段匹配绑定并调用 `layout.selectPanel`；录制期间用共享标记让打开逻辑让位，避免边录边触发。

### 总行数

结果栏默认只显示本次返回的行数；用户要的是“这张表/这个条件到底多少行”，所以旁边放一个刷新按钮，按需对**已执行的语句**做一次 `SELECT COUNT(*) FROM (<statement>) AS dw_count`。包一层派生表的好处是 `WHERE`/`GROUP BY`/`LIMIT` 原样生效，不用在客户端解析 SQL；`SHOW`/`EXPLAIN` 不能包派生表，按钮对它们直接禁用。COUNT 是第二次全表扫描，所以不做自动统计，只在点击时发一次请求。统计前会剥掉最外层的 `LIMIT`（子查询里的保留），否则数出来的永远只是预览行数。主查询与 COUNT 的原样 SQL 都会以 `SQL` 行进入运行日志——日志是控制台历史，失败语句也记。

### 控制台持久化

SQL 是用户的工作成果，工作区切换不能把它丢掉。快照放在 Host：每个工作区一份 `<hash16>-<名字>.consoles.json`（与发现缓存同一个 `workspaces/` 目录，0600，临时文件 + rename 原子写）。文件里只有各标签的 id、库信息、标题和 SQL 文本，**不存结果**，恢复后就是一条待执行的语句。

最初放在浏览器 `localStorage`，但 DSH 每次启动用随机端口，localStorage 按 origin 隔离，重启后等于换了一个存储空间——这正好违背“除非我删掉不然一直在”的要求。因此改为 Host 文件：与端口、浏览器、profile 都无关。输入时 250ms 防抖写 Host，切换工作区/关闭面板/刷新前 flush；关闭标签是明确的删除动作，立即写回。旧版本留下的 localStorage 快照会在该工作区第一次打开时迁移到 Host 并删除原键。

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
| 解析成功但没有本项目的数据源 | `environments === []` | 说明窗口只读本项目自己的 `spring.datasource`，并提示检查应用名与 Nacos 快照；不再列出别处的实例 |
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
| 所有工作区共用一份 `discovery.json` | 所有项目的凭据挤在一个文件里、坏文件连累全部、无法单独忘记某个项目；改为每个工作区一份 |
| 发现结果只按 `env` 合并多个 nacos | 见第 2 节：会把另一套集群的主机混进来 |
| 用快照里其它 data-id 声明的全部实例兜底 | 混进其它项目的实例，账号只能猜（`Access denied` / `ENOTFOUND`），树很乱；改为只列本项目数据源声明的实例 |
| 写死运维数据源文件名（`yunwei-db.yml`） | 别的项目把同样的变量放在 `db.yml` / `datasource.yml` / 自定义 data-id 里就解析不到；改为按占位符找定义它的文件 |

---

## 12. 验证矩阵

| 项 | 方式 | 状态 |
|---|---|---|
| 配置解析（3 级引用、多缓存去重） | Node 直接跑 `discoverProject` | 已验（真实 nacos 缓存，4 环境） |
| 只列本项目声明的实例 | `discoverProject` 分别跑无数据源工作区与真实项目 | 已验（无数据源：environments=0；项目：dev1 2 库 2 实例、qa2 3 库） |
| 不依赖运维文件名 | 临时快照：变量写在 `team-db.yml`，项目 URL 引用 `${acme.dbs.main-db}` | 已验（解析出 10.0.0.9:3307、别名 `main-db`，只读该文件；改文件后缓存失效） |
| 自包含项目 | 数据源与变量都在 app data-id 内 | 已验（无外部变量文件也能解析） |
| 发现缓存命中/失效 | `DataController` 连续两次 discover | 已验（第二次 `cached=true`） |
| 实例/库/表/字段/DDL/查询 | 对着 dev1 `demo_order` 真跑 | 已验（174 库 / 65 表 / DDL / 33ms 查询） |
| 只读四层 | 构造 `UPDATE`、`SELECT 1; DROP`、`WITH … DELETE` | 已验（均被拒，且服务端也拒绝写） |
| 派生库 id（浏览全部库） | `databases` → 用返回 id 查 tables/query | 已验 |
| 行数截断判定 | `limit=2` 对恰好 2 行 / 3 行 | 已验（false / true） |
| 插件槽位注册 | `cordis_inspect_query` Slots | 已验（main + footer 均 active） |
| Host 路由存活与围栏 | 无令牌 POST 应得 403 自家 JSON | 已验 |
| 界面渲染 / 交互观感 | CDP 驱动真实鼠标键盘 + 截图 | 已验（见 CHANGELOG 0.1.0） |

---

## 13. 演进方向

按收益排序，供下一次会话直接接手：

1. **查询取消**：Host 侧给每次 `query` 发 queryId，`action: 'cancel'` 时 `connection.destroy()`；客户端运行按钮变"停止"。
2. **结果导出 CSV / 单元格复制**：TSV 复制已有，CSV 只是编码差异。
3. **执行计划**：`EXPLAIN` 已在白名单里，缺一个"对当前语句执行 EXPLAIN"的入口与结果渲染。
4. **编辑器渲染优化**：输入仍然整 store patch，大结果下可感知；可把 SQL 文本放到组件本地 state + 防抖回写。
5. **多语句脚本**：现在严格单语句；可做"选中什么跑什么"的脚本执行（逐条串行 + 汇总结果）。
6. **表数据分页**：双击表固定 `LIMIT 100`，可以加 offset 翻页。
