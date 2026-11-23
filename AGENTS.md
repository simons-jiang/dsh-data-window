# dsh-data-window — 项目开发须知

DataGrip 风格的 DSH 数据库窗口插件。本文件是这个工作区的**项目级约定**，新会话请先读它和 `docs/DESIGN.md`。

## 一句话职责

不新建任何连接配置：读工作区自己的 Spring/Nacos 配置拿到各环境的主机与账号，渲染成"环境 → 实例 → 库 → 表 → 字段"的树，每个库一个只读 SQL 工作台。

## 不可让步的三条

1. **只读**。任何改动都不能放松 `src/host/mysql.js` 的四层拦截（白名单 / 单语句 / 写关键字 / `SET SESSION TRANSACTION READ ONLY`）。这是用户的硬约束，不是可选项。
2. **密码不出 Host**。客户端只拿不透明连接 id（`i:…` / `d:…`），凭据只在 Host 进程内存与 0600 缓存文件里。
3. **不覆盖用户 SQL**。树上的任何动作都不许改写用户已经写好的语句；需要新语句就开第二个工作台（`store.seedStatement`）。

## 目录职责

| 路径 | 职责 |
|---|---|
| `index.js` | Host 入口：注册 `POST /dsh-data/rpc`、构造控制器、读 package 版本用于缓存失效 |
| `src/host/yaml.js` | YAML 子集解析（缩进映射/列表/多文档/注释/引号），`${a.b:default}` 占位符解析 |
| `src/host/discovery.js` | 配置发现：`bootstrap.yml` → 应用名 → Nacos 快照 → `yunwei-db.yml`，产出环境/实例/库与连接目标表 |
| `src/host/mysql.js` | 只读网关：连接池、语句校验、元数据与 DDL 查询、行数上限 |
| `src/host/rpc.js` | action 分发（discover/ping/databases/tables/columns/ddl/query/config/forget）、错误→HTTP 映射 |
| `src/host/cache.js` | 按工作区的发现缓存（文件指纹 + 插件版本），0600，写临时文件再 rename |
| `src/client/*.js` | 面板源码，`node build.mjs` 拼成单文件 `client.js` |
| `build.mjs` | 拼接 + 注入语言字典 + 未定义 helper 检查 + 去掉模块语法 |
| `locale/{en,zh}.json` | 显示名（`meta`）+ 全部界面文案，客户端把它内联进 bundle |
| `test/ui-verify.mjs` | CDP 驱动的界面验证脚本（真实鼠标/键盘） |
| `docs/screenshots/` | 验证留档（工作台、建表语句） |

## 开发循环

```sh
node build.mjs            # 改完 src/client/*.js 必须重新生成 client.js
node --check client.js    # 语法
npm install --omit=dev    # 只在首次或依赖变化时（link 安装从本目录解析 node_modules）
```

装到 profile（已装过的新版本需要先移除）：

```
plugin_manager remove_bundle  dsh-data-window
plugin_manager install_bundle /path/to/dsh-data-window
```

**生效条件**：客户端改动刷新窗口即可；Host 改动要一次模块重新加载（移除+安装通常就够，否则重启应用）。

## 验证方式（重要）

### Host 侧：脱离 GUI 直接跑

`DataController` 不依赖 cordis，用 Node 脚本 `discover → databases → tables → columns → ddl → query` 即可，或带上鉴权 cookie 打真实路由：

```sh
curl -c /tmp/cj -o /dev/null "http://127.0.0.1:<port>/?token=<启动令牌>"     # 换 30 天 cookie
curl -b /tmp/cj -X POST "http://127.0.0.1:<port>/dsh-data/rpc" \
     -H 'content-type: application/json' -d '{"action":"discover","root":"…","refresh":true}'
```

### 界面：自己开浏览器验证，不要推给用户

宿主页面要启动令牌，直接开 `http://127.0.0.1:<port>/` 会 401。拿令牌的正规方式是**让 Host 自己生成**：

```js
// 临时加在 index.js 的 apply 里，验证完删掉
writeFileSync(join(cacheDirectory, 'launch-url.txt'),
  ctx.get('connection').authenticatedUrl(ctx.webServer.getOrigin()), { mode: 0o600 })
```

移除+安装让 Host 重新加载后，读 `~/.dsh/storages/dsh-data-window/launch-url.txt`，用它换 cookie（30 天有效，换一次能反复用）。

然后用 `test/ui-verify.mjs` 驱动（CDP + 真实鼠标键盘，不是 `dispatchEvent`）：

```sh
node test/ui-verify.mjs "http://127.0.0.1:<port>/?token=<令牌>" \
     /path/to/your-service /tmp/shots
```

它会输出 6 张截图（面板 / 展开环境 / 展开实例 / 工作台 / 结果 / DDL）和每步的 DOM 文本，并报告 console error。

两个必知的坑：

- **默认环境是自动展开的**，第一次点环境行是"收起"，不是展开；脚本要先数 `.dw-node-instance`。
- **发现结果有磁盘缓存**，改了 `discovery.js` 的输出语义（不只是文件格式）必须 bump `cache.js` 的 `CACHE_VERSION`，否则旧 payload 会继续命中，界面看不到新字段。

## 已知边界

- 只支持 MySQL/MariaDB。
- 必须本机已有 Nacos 快照缓存，否则只能列实例、列不到项目配好的库。
- 查询不能取消，最长 60 秒（`statementTimeoutMs`）。
- 一次只连一个实例的库；跨库请写 `库名.表名`。
- 远端是 `github.com/simons-jiang/dsh-data-window`（公开仓库，截图与文档已脱敏）；提交与推送仍需用户明确发话（全局规范）。

## 待办（按价值排序）

1. 查询取消（Host 记录 queryId + `connection.destroy()`）。
2. 结果导出 CSV、单元格复制。
3. 执行计划（`EXPLAIN` 已有白名单，缺 UI）。
4. 编辑器大结果下的渲染优化（网格已 memo，输入仍是整 store patch）。
5. `EXPLAIN`/`SHOW` 结果的可读化。

细节与取舍理由见 `docs/DESIGN.md`。
