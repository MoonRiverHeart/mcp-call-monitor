// mcp-call-monitor-plugin — OpenCode plugin for auto-recording tool/MCP calls
// ESM JavaScript, no external dependencies

const BUILTIN_TOOLS = new Set([
  "bash", "read", "edit", "write", "glob", "grep", "webfetch", "todowrite",
  "question", "look_at", "lsp_diagnostics", "lsp_find_references",
  "lsp_goto_definition", "lsp_install_decision", "lsp_prepare_rename",
  "lsp_rename", "lsp_status", "lsp_symbols", "session", "session_info",
  "session_list", "session_read", "session_search", "skill", "skill_mcp",
  "task", "team_broadcast", "team_claim", "team_cleanup", "team_create",
  "team_merge", "team_message", "team_results", "team_shutdown",
  "team_spawn", "team_status", "team_tasks_add", "team_tasks_complete",
  "team_tasks_list", "team_view", "todowrite", "token_export",
  "token_history", "token_stats", "background_cancel", "background_output",
  "invalid", "plugin_marketplace_install", "plugin_marketplace_list",
  "plugin_marketplace_search", "marketplace_add", "marketplace_list",
  "marketplace_remove", "puppeteer_puppeteer_click",
  "puppeteer_puppeteer_evaluate", "puppeteer_puppeteer_fill",
  "puppeteer_puppeteer_hover", "puppeteer_puppeteer_navigate",
  "puppeteer_puppeteer_screenshot", "puppeteer_puppeteer_select",
  "edgeone-pages_deploy_folder_or_zip", "edgeone-pages_deploy_html",
  "codegraph_codegraph_callers", "codegraph_codegraph_explore",
  "codegraph_codegraph_node", "codegraph_codegraph_search",
  "context7_query-docs", "context7_resolve-library-id",
  "mcp-call-monitor_mcp_monitor_collect_stats",
  "mcp-call-monitor_mcp_monitor_analyze_error",
  "mcp-call-monitor_mcp_monitor_upload_report",
  "mcp-call-monitor_mcp_monitor_full_scan",
  "bilibili_check_bilibili_credentials", "bilibili_check_mcp_update",
  "bilibili_get_credential_setup_instructions",
  "bilibili_get_video_comments", "bilibili_get_video_info",
  "bilibili_get_video_metadata", "bilibili_get_video_transcript",
  "echarts_generate_area_chart", "echarts_generate_bar_chart",
  "echarts_generate_boxplot_chart", "echarts_generate_candlestick_chart",
  "echarts_generate_echarts", "echarts_generate_funnel_chart",
  "echarts_generate_gauge_chart", "echarts_generate_graph_chart",
  "echarts_generate_heatmap_chart", "echarts_generate_line_chart",
  "echarts_generate_parallel_chart", "echarts_generate_pie_chart",
  "echarts_generate_radar_chart", "echarts_generate_sankey_chart",
  "echarts_generate_scatter_chart", "echarts_generate_sunburst_chart",
  "echarts_generate_tree_chart", "echarts_generate_treemap_chart",
  "search_session_logs", "websearch_web_search_exa", "webfetch",
  "grep_app_searchGitHub",
]);

const ERROR_PATTERNS = [
  { regex: /timeout|timed out|ETIMEDOUT/i, type: "timeout" },
  { regex: /permission|access denied|EACCES/i, type: "permission_denied" },
  { regex: /network|ECONNREFUSED|ENOTFOUND|fetch failed/i, type: "network_error" },
  { regex: /invalid|parse|format|schema/i, type: "invalid_response" },
  { regex: /auth|cookie|token|credential|expired/i, type: "auth_expired" },
];

function classifyError(errorMessage) {
  if (!errorMessage) return "unknown";
  for (const { regex, type } of ERROR_PATTERNS) {
    if (regex.test(errorMessage)) return type;
  }
  return "unknown";
}

function hasErrorIndicator(outputText) {
  if (!outputText) return false;
  const indicators = ["MCP error", "Error:", "error -32603", "error:", "failed", "ETIMEDOUT", "ECONNREFUSED"];
  return indicators.some((ind) => outputText.includes(ind));
}

function truncate(str, maxLen) {
  if (!str) return null;
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen);
}

function parseMcpToolName(toolName) {
  // MCP tool names follow pattern: mcpServer_toolName
  // e.g. "bilibili_check_mcp_update" → mcpServer="bilibili", toolName="check_mcp_update"
  // But some have multi-segment: "mcp-call-monitor_mcp_monitor_collect_stats"
  // Split on first _ to get server prefix, rest is toolName
  const idx = toolName.indexOf("_");
  if (idx === -1) return { mcpServer: toolName, mcpToolName: "" };
  return {
    mcpServer: toolName.slice(0, idx),
    mcpToolName: toolName.slice(idx + 1),
  };
}

function isMcpCall(toolName) {
  // MCP calls: tool name contains _ AND is NOT in builtin set
  return toolName.includes("_") && !BUILTIN_TOOLS.has(toolName);
}

function getDashboardUrl(options) {
  return options?.serverUrl || process.env.DASHBOARD_URL || "http://localhost:3210";
}

function fireAndForget(url, payload) {
  fetch(`${url}/api/call`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }).catch((err) => {
    console.error("[mcp-call-monitor-plugin] POST /api/call failed:", err.message);
  });
}

export const id = "mcp-call-monitor-plugin";

export const server = async (input, options) => {
  const dashboardUrl = getDashboardUrl(options);

  return {
    "tool.execute.after": async (input, output) => {
      const tool = input.tool;
      const sessionId = input.sessionID;
      const callId = input.callID;
      const args = input.args;

      const outputTitle = output.title;
      const outputText = output.output;
      const metadata = output.metadata;

      const mcp = isMcpCall(tool);
      const { mcpServer, mcpToolName } = mcp ? parseMcpToolName(tool) : { mcpServer: null, mcpToolName: null };

      const hasError = hasErrorIndicator(outputText) || hasErrorIndicator(outputTitle);
      const success = !hasError;

      let errorMessage = null;
      let errorType = null;
      if (!success) {
        // Combine title + output for error detection
        const combined = `${outputTitle || ""} ${outputText || ""}`;
        errorMessage = truncate(combined, 500);
        errorType = classifyError(combined);
      }

      const payload = {
        sessionId,
        callId,
        timestamp: new Date().toISOString(),
        tool,
        isMcpCall: mcp,
        mcpServer,
        mcpToolName,
        success,
        errorMessage,
        errorType,
        durationMs: null,
        argsSummary: truncate(JSON.stringify(args), 500),
        outputSummary: truncate(outputText, 200),
      };

      fireAndForget(dashboardUrl, payload);
    },

    event: async (event) => {
      if (event.type === "session.idle" || event.type === "session.deleted") {
        console.log(`[mcp-call-monitor-plugin] Session event: ${event.type} — session ending`);
      }
    },
  };
};
