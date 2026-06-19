# server 子目录知识库

## 概述

Express 5 后端，单文件架构，API + 去重 + Badge + SSE + 静态托管。

## 去哪里找

| 任务 | 位置 | 备注 |
|------|------|------|
| API 路由 | `index.js` L57-153 | POST /api/call(去重), POST /api/report, GET /api/stats, GET /api/errors, DELETE /api/errors |
| 去重机制 | `index.js` L39-46 | `seenCallIds` Set + 启动时从 data.json 种子加载 |
| SSE 端点 | `index.js` L157-183 | GET /api/events, 30s 心跳保活 |
| Badge 生成 | `index.js` L225-266 | `makeBadge()` 函数，CJK 字宽 12px / Latin 6px |
| Badge 端点 | `index.js` L278-309 | /api/badge/mcp, /tools, /errors, /summary |
| SSE 客户端管理 | `index.js` L34-45 | `sseClients` Set + `broadcast()` |
| 数据读写 | `index.js` L11-30 | `readData()` / `writeData()`，同步 fs 操作 |
| 静态托管 | `index.js` L53 | `express.static('public')`，dashboard 副本 |

## 约定

- CommonJS（`type: "commonjs"`），`require()` 导入，不用 ESM import。
- Express 5.2.1，`app.listen(PORT, callback)` 不返回 server 实例，无法引用关闭。
- 单文件架构，路由/Badge/SSE 全内联 `index.js`，不拆模块。
- POST `/api/call` 去重：`seenCallIds` 内存 Set（启动时种子加载 data.json 已有 callIds），同 callId 返回 `{ok:true,dedup:true}`
- 数据持久化用 `data.json` 同步读写（`fs.readFileSync` / `fs.writeFileSync`），无锁，单实例部署。
- JSON body 限制 1mb（`express.json({ limit: '1mb' })`）。
- Badge label 背景：暗色 `#3A3966`，亮色 `#e0e0ec`；value 文本 fill：暗色 `#fff`，亮色 `#333355`。
- Badge 查询参数：`?style=flat|rounded&theme=light|dark`，默认 rounded + dark。
- errors badge 颜色随数量变化：0 绿 `#91cc75`，≤5 黄 `#fac858`，>5 红 `#ee6666`。

## 反模式

- **禁止** Express 4 语法（如 `const server = app.listen()`），Express 5 不返回实例。
- **禁止** `Start-Process -NoNewWindow` 启动，会挂起 PowerShell。
- **禁止** 异步 fs 操作读写 data.json，当前用同步 API，混用会破坏数据一致性。
- **禁止** 拆分 index.js 为多文件，本项目刻意单文件。

## 备注

- 端口 3210，`npm start` 即 `node index.js`。
- data.json 无并发锁，多实例部署会丢数据，只跑一个进程。
- SSE 心跳 30s（`:heartbeat\n\n`），客户端断开时自动从 Set 移除。
- broadcast 写失败时静默删除客户端，不抛异常。
- DELETE /api/errors 清空全部数据并广播 `data_cleared` 事件。
- `public/index.html` 是 dashboard 副本，修改 dashboard 后需手动同步。
