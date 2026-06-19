# mcp-call-monitor 子目录知识库

## 概述

三模块 monorepo：mcp-server（TypeScript ESM）+ server（Express 5 CommonJS）+ dashboard（纯 HTML 单文件）+ plugin（Hook 脚本）。

## 去哪里找

| 任务 | 位置 | 备注 |
|------|------|------|
| MCP 工具 schema | `mcp-server/src/index.ts` | Zod 验证，5 工具入口（含 trends） |
| API 路由 + 去重 + Badge + SSE | `server/index.js` | POST /api/call(去重), POST /api/report, GET /api/stats, GET /api/errors, SSE /api/events |
| Dashboard 视图 + 主题 | `dashboard/index.html` | 4 视图，ChatGPT 分栏，CSS 变量双主题 |
| 数据存储 | `server/data.json` | JSON 文件，server 启动时读写 |
| MCP 编译产物 | `mcp-server/dist/index.js` | tsc 输出，opencode.json 指向此路径 |
| 静态托管副本 | `server/public/index.html` | dashboard 的镜像，Express 托管 |

## 约定

- mcp-server 用 ESM（`type: "module"`），server 用 CommonJS（`type: "commonjs"`）。跨模块 import 不可混用，mcp-server 通过 HTTP 调 server，不走 require/import。
- mcp-server 所有工具参数用 Zod schema 校验，返回值也走 schema。
- server 单文件架构（`index.js`），路由、Badge、SSE 全内联，不拆模块。
- dashboard 无构建步骤，ECharts 从 CDN 加载，所有样式用 CSS 变量（`--bg`, `--text`, `--accent` 等）。
- 数据流单向：Hook → HTTP POST → Express → SSE → Dashboard。Dashboard 不回写 server。
- 侧边栏折叠：CSS class `narrow`，宽度 220→64px，JS 切换 `classList.toggle('narrow')`。

## 反模式

- **禁止** dashboard 引入外部 CSS 框架（Tailwind、Bootstrap 等）。
- **禁止** 硬编码颜色值，必须用 CSS 变量。
- **禁止** 用 `collapsed` 操作侧边栏，正确 class 是 `narrow`。
- **禁止** Express 4 语法（`app.listen(port, cb)`），Express 5 不返回 server 实例。
- **禁止** `Start-Process -NoNewWindow` 启动 server，会挂起进程。
- **禁止** mcp-server 直接 require server 模块，模块系统不同，只能 HTTP 通信。
- **禁止** 在 plugin/hooks/hooks.json 注册 Hook（会导致双重触发）。

## 备注

- dashboard/index.html 修改后必须手动复制到 server/public/index.html，无自动同步。
- Express 5 `app.listen()` 不返回 server 实例，SSE 关闭需用 `process.on('SIGTERM')` + 全局引用。
- Badge API：`/api/badge?style=flat|rounded&theme=light|dark`，label 背景暗色 `#3A3966`，亮色 `#e0e0ec`。
- server 端口 3210，mcp-server 通过 opencode.json 配置启动，不手动运行。
- data.json 无锁机制，并发写入可能丢数据，单实例部署即可。
