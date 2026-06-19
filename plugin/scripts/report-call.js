// mcp-call-monitor PostToolUse/PostToolUseFailure hook script
// Receives JSON via stdin from OpenCode Claude Code compat hooks, POSTs to Express server
// Stdin format (Claude Code compat):
//   { session_id, transcript_path, cwd, permission_mode, hook_event_name,
//     tool_name (PascalCase transformed), tool_input, tool_response, tool_use_id, hook_source }

const BUILTIN_TOOLS_PASCAL = new Set([
  "Bash", "Read", "Edit", "Write", "Glob", "Grep",
  "WebFetch", "WebSearch", "TodoWrite", "TodoRead",
  "Question", "LookAt", "Session", "Skill", "Task",
  "LspDiagnostics", "LspFindReferences", "LspGotoDefinition",
  "LspPrepareRename", "LspRename", "LspStatus", "LspSymbols",
  "Todowrite"
]);

const MCP_SERVER_PREFIXES = [
  "mcpCallMonitor", "bilibili", "puppeteer", "codegraph",
  "echarts", "edgeOnePages", "context7", "grepApp",
  "marketplace", "pluginMarketplace",
  "tokenStats", "tokenHistory", "tokenExport",
  "team", "sessionInfo", "sessionList", "sessionRead", "sessionSearch"
];

const ERROR_PATTERNS = [
  { regex: /timeout|timed out|ETIMEDOUT/i, type: "timeout" },
  { regex: /permission|access denied|EACCES/i, type: "permission_denied" },
  { regex: /network|ECONNREFUSED|ENOTFOUND|fetch failed/i, type: "network_error" },
  { regex: /invalid|parse|format|schema|VALIDATION/i, type: "invalid_response" },
  { regex: /auth|cookie|token|credential|expired|COOKIE_EXPIRED/i, type: "auth_expired" },
];

const LOG_FILE = "C:\\Users\\94023\\Documents\\vscode\\test\\mcp-call-monitor\\plugin\\scripts\\hook-debug.log";

function classifyError(msg) {
  if (!msg) return "unknown";
  for (const { regex, type } of ERROR_PATTERNS) {
    if (regex.test(msg)) return type;
  }
  return "unknown";
}

function truncate(str, maxLen) {
  if (!str) return null;
  if (typeof str !== "string") str = JSON.stringify(str);
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen);
}

function extractText(response) {
  if (!response) return "";
  if (typeof response === "string") return response;
  // MCP tool response: could be { content: [{type:"text",text:"..."}] } or { output: "..." }
  if (response.content && Array.isArray(response.content)) {
    return response.content
      .filter(c => c.type === "text")
      .map(c => c.text || "")
      .join("\n");
  }
  if (response.output) return typeof response.output === "string" ? response.output : JSON.stringify(response.output);
  if (response.result) return typeof response.result === "string" ? response.result : JSON.stringify(response.result);
  // Fallback: try common fields
  for (const key of ["text", "message", "error", "data", "body"]) {
    if (response[key]) return typeof response[key] === "string" ? response[key] : JSON.stringify(response[key]);
  }
  return JSON.stringify(response);
}

function logDebug(msg) {
  try {
    const fs = require("fs");
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    fs.appendFileSync(LOG_FILE, line);
  } catch {}
}

let stdin = "";
process.stdin.on("data", (chunk) => { stdin += chunk; });
process.stdin.on("end", async () => {
  try {
    if (!stdin.trim()) { logDebug("Empty stdin, exiting"); process.exit(0); return; }

    const data = JSON.parse(stdin);
    logDebug(`Received: event=${data.hook_event_name} tool=${data.tool_name} session=${data.session_id}`);

    const toolName = data.tool_name || "";  // PascalCase as received
    const sessionId = data.session_id || "";
    const callId = data.tool_use_id || data.call_id || "";
    const args = data.tool_input || {};
    const response = data.tool_response || data.tool_output || {};
    const hookEvent = data.hook_event_name || "";

    const isBuiltin = BUILTIN_TOOLS_PASCAL.has(toolName);
    let isMcp = false, mcpServer = null, mcpToolName = null;
    if (!isBuiltin && toolName.length > 3) {
      for (const prefix of MCP_SERVER_PREFIXES) {
        if (toolName.toLowerCase().startsWith(prefix.toLowerCase())) {
          isMcp = true;
          const rest = toolName.slice(prefix.length);
          mcpServer = prefix;
          mcpToolName = rest || toolName;
          break;
        }
      }
      if (!isMcp) {
        isMcp = true;
        mcpServer = "unknown";
        mcpToolName = toolName;
      }
    }

    // Extract output text for error detection
    const outputText = extractText(response);
    logDebug(`Output text length: ${outputText.length}, first 100: ${truncate(outputText, 100)}`);

    // Determine success
    const isFailureEvent = hookEvent === "PostToolUseFailure";
    const errorIndicators = ["MCP error", "Error:", "error -32603", "error:", "failed", "ETIMEDOUT", "ECONNREFUSED"];
    const hasErrorInOutput = errorIndicators.some((ind) => outputText.includes(ind));
    const success = !isFailureEvent && !hasErrorInOutput;

    let errorMessage = null, errorType = null;
    if (!success) {
      errorMessage = truncate(outputText, 500);
      errorType = isFailureEvent ? "hook_failure" : classifyError(outputText);
      logDebug(`Error detected: type=${errorType}, msg=${truncate(errorMessage, 100)}`);
    }

    const localPayload = {
      sessionId,
      callId: callId || `hook-${Date.now()}`,
      timestamp: new Date().toISOString(),
      tool: toolName,
      model: data.model || "unknown",
      isMcpCall: isMcp,
      mcpServer,
      mcpToolName,
      success,
      errorMessage,
      errorType,
      argsSummary: truncate(JSON.stringify(args), 500),
      outputSummary: truncate(outputText, 200),
    };

    const remotePayload = {
      callId: callId || `hook-${Date.now()}`,
      timestamp: new Date().toISOString(),
      tool: toolName,
      model: data.model || "unknown",
      isMcpCall: isMcp,
      mcpServer,
      mcpToolName,
      success: success,
      errorType: errorType,
    };

    logDebug(`Posting local: tool=${toolName} success=${success} isMcp=${isMcp}`);

    try {
      const localRes = await fetch("http://127.0.0.1:3210/api/call", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(localPayload),
      });
      logDebug(`Local response: status=${localRes.status}`);
    } catch (e) {
      logDebug(`Local POST failed: ${e.message}`);
    }

    try {
      const remoteRes = await fetch("https://mcp-call-monitor.edgeone.dev/api/call", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(remotePayload),
      });
      logDebug(`Remote response: status=${remoteRes.status}`);
    } catch (e) {
      logDebug(`Remote POST failed: ${e.message}`);
    }
  process.exit(0);
});
