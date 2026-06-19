# mcp-server 子目录知识库

## 概述

TypeScript ESM MCP Server，@modelcontextprotocol/sdk + Zod，5 工具，stdio 传输。

## 去哪里找

| 任务 | 位置 | 备注 |
|------|------|------|
| 5 工具定义 + handler | `src/index.ts` | collect_stats / analyze_error / upload_report / full_scan / trends |
| 类型定义 | `src/index.ts` L13-47 | McpCallCounts, ToolCallCounts, ErrorRecord, SessionStats, UploadPayload |
| Zod schema | `src/index.ts` L327-430 | CollectStatsSchema, AnalyzeErrorSchema, UploadReportSchema, FullScanSchema |
| 错误分类 | `src/index.ts` L53-74 | KNOWN_ERROR_PATTERNS + classifyError() |
| LLM 分析 | `src/index.ts` L121-170 | generateLlmAnalysis()，OpenAI 兼容 API |
| 编译产物 | `dist/index.js` | opencode.json 指向此路径 |
| tsconfig | `tsconfig.json` | strict + 三额外检查 |

## 约定

- `type: "module"`，ESM，import 带 `.js` 后缀（@modelcontextprotocol/sdk 要求）
- `module: "NodeNext"` + `moduleResolution: "NodeNext"`，Node 原生 ESM 解析
- tsconfig strict + `noUncheckedIndexedAccess` + `noImplicitOverride` + `noPropertyAccessFromIndexSignature`
- 所有工具参数用 Zod schema 校验（`Schema.parse(args ?? {})`），不手动校验
- 工具名前缀 `mcp_monitor_`，与 opencode.json 注册名一致
- collect_stats filesystem 为零时 → HTTP fallback 到 Express `/api/stats` + `/api/errors`，返回 `source:"express_server"`
- trends 工具：GET `/api/calls` → 按时间段聚合返回 `{buckets, summary}`
- 错误分类 5 种：timeout / permission_denied / network_error / invalid_response / auth_expired，未匹配返回 unknown
- LLM 分析可选：设 `LLM_API_URL` + `LLM_API_KEY` 启用，未设则降级到 generatePatternAnalysis()
- serverUrl 优先级：参数 > `DASHBOARD_URL` 环境变量 > 默认 `http://localhost:3210`

## 反模式

- **禁止** 用 `require()`，ESM 模块只能 `import`
- **禁止** import 不带 `.js` 后缀（NodeNext 解析要求）
- **禁止** 跳过 Zod 校验直接访问 args，必须 `Schema.parse()`
- **禁止** 新增错误类型不更新 KNOWN_ERROR_PATTERNS
- **禁止** 直接 require/import server 模块，模块系统不同，只能 HTTP

## 备注

- 编译：`npm run build`（tsc），输出到 `dist/`
- 启动：通过 opencode.json 配置，不手动 `npm start`
- 环境变量：`DASHBOARD_URL`（默认 localhost:3210）、`LLM_API_URL`、`LLM_API_KEY`、`LLM_MODEL`（默认 gpt-4o-mini）
- Session 文件发现：扫描 `%APPDATA%\opencode`、`%LOCALAPPDATA%\opencode`、`~/.opencode` 等路径
- full_scan = collect_stats + analyze_error + upload_report 三合一，单次调用完成全流程
