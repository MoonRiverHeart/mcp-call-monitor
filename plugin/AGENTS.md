# plugin 子目录知识库

## 概述

Claude Code compat Hook 脚本，OpenCode PostToolUse/PostToolUseFailure 事件 → stdin JSON 解析 → MCP/工具分类 → fire-and-forget POST 到 Express `/api/call`。

## 去哪里找

| 任务 | 位置 | 备注 |
|------|------|------|
| Hook 脚本核心 | `scripts/report-call.js` | stdin → PascalCase解析 → MCP检测 → POST |
| Hook 调试日志 | `scripts/hook-debug.log` | `logDebug()` 追加写入，require("fs") |
| PowerShell 旧脚本 | `scripts/report-call.ps1` | 已弃用，PS5 不支持 `??` |
| Hook 声明 | `hooks/hooks.json` | 已清空，只保留 description |
| Plugin 包定义 | `package.json` | `type: "module"` 但脚本用 require() |

## Hook stdin 格式

OpenCode 传 PascalCase 转换后的 JSON：

| 字段 | 类型 | 说明 |
|------|------|------|
| `session_id` | string | OpenCode session ID |
| `tool_name` | string | **PascalCase**（`transformToolName()` 转换） |
| `tool_input` | object | `objectToSnakeCase()` 转换后的参数 |
| `tool_response` | object/string | 工具输出（**不是** `tool_output`） |
| `tool_use_id` | string | 调用唯一 ID（**不是** `call_id`） |
| `hook_event_name` | string | `"PostToolUse"` 或 `"PostToolUseFailure"` |

### tool_name PascalCase 转换

原始 → PascalCase 示例：
- `bash` → `"Bash"`
- `read` → `"Read"`  
- `mcp-call-monitor_mcp_monitor_collect_stats` → `"McpCallMonitorMcpMonitorCollectStats"`
- `bilibili_get_video_info` → `"BilibiliGetVideoInfo"`
- `webfetch` → `"WebFetch"`（特殊映射）
- `todowrite` → `"TodoWrite"`（特殊映射）

**关键**：含 `-` 或 `_` 的名字 → `toPascalCase()` 拆分拼接无分隔符，无法逆向还原 server/tool。

## MCP 检测逻辑

```
tool_name ∈ BUILTIN_TOOLS_PASCAL → 内置工具 (isMcpCall:false)
tool_name ∉ BUILTIN_TOOLS_PASCAL → 检查 MCP_SERVER_PREFIXES 前缀匹配
  匹配 → isMcpCall:true, mcpServer=前缀, mcpToolName=剩余部分
  不匹配 → isMcpCall:true, mcpServer="unknown", mcpToolName=全名
```

### BUILTIN_TOOLS_PASCAL（已知内置）

Bash, Read, Edit, Write, Glob, Grep, WebFetch, WebSearch, TodoWrite, TodoRead, Question, LookAt, Session, Skill, Task, LspDiagnostics, LspFindReferences, LspGotoDefinition, LspPrepareRename, LspRename, LspStatus, LspSymbols, Todowrite

### MCP_SERVER_PREFIXES（按 PascalCase 前缀）

mcpCallMonitor, bilibili, puppeteer, codegraph, echarts, edgeOnePages, context7, grepApp, marketplace, pluginMarketplace, tokenStats, tokenHistory, tokenExport, team, sessionInfo, sessionList, sessionRead, sessionSearch

## 错误检测

- `hook_event_name === "PostToolUseFailure"` → 直接标记失败
- 输出文本含 `"MCP error"/"Error:"/"failed"` 等 → 标记失败
- `classifyError()` 匹配 5 种类型：timeout / permission_denied / network_error / invalid_response / auth_expired

## 约定

- Hook 注册**只在** `.claude/settings.local.json`，`plugin/hooks/hooks.json` 已清空（避免双重触发）
- npm 缓存 `~/.cache/opencode/packages/mcp-call-monitor-plugin@latest/` 的 hooks.json 也已清空
- `matcher: ""` 捕获所有工具调用（无过滤）
- `async: true` 后台非阻塞执行，不阻塞 OpenCode 主流程
- 脚本用 `require("fs")` 写日志（虽 package.json 标 `type: "module"`，脚本本身不是 ESM）

## 反模式

- **禁止** 在 plugin/hooks/hooks.json 注册 Hook（会导致双重触发）
- **禁止** 用 `tool_output`/`call_id`/原始 snake_case tool_name（Claude Code compat 传 PascalCase `tool_name`、`tool_response`、`tool_use_id`）
- **禁止** 用 `tool.includes("_")` 检测 MCP（PascalCase 无 `_`，必须用前缀匹配）
- **禁止** 同步等待 Express 响应（fire-and-forget POST，脚本必须快速退出）

## 备注

- 调试：`logDebug()` 写入 `hook-debug.log`，每次 Hook 触发追加时间戳+关键字段
- 手动测试：`echo '{"session_id":"test","tool_name":"Bash",...}' | node scripts/report-call.js`
- Express 去重：`seenCallIds` Set 内存去重，同 callId 重复 POST 返回 `{ok:true,dedup:true}`
