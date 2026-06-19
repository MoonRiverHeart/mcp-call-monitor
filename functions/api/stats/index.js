export async function onRequestGet({ request, env }) {
  try {
    const dataKey = "calls_data";
    const callsData = await MCP_KV.get(dataKey, "json") || { calls: [], lastUpdated: null };

    const calls = callsData.calls || [];
    const byModel = {};
    const byTime = { hourly: {}, daily: {} };
    const byMcpServer = {};
    const byTool = {};
    const bySkill = {};
    const bySession = {};
    const SKILL_PATTERNS = ['skill', 'TodoWrite', 'Task', 'Session', 'Team', 'Background', 'Lsp', 'Token', 'Marketplace', 'Plugin', 'Context7'];
    let totalCalls = 0, totalMcpCalls = 0, totalToolCalls = 0, totalSkillCalls = 0;
    let totalSuccess = 0, totalErrors = 0;
    let mcpSuccess = 0, mcpErrors = 0, toolSuccess = 0, toolErrors = 0;
    let skillSuccess = 0, skillErrors = 0;

    for (const call of calls) {
      totalCalls += 1;
      const ok = call.success ? 1 : 0;
      const err = call.success ? 0 : 1;
      totalSuccess += ok;
      totalErrors += err;
      const isMcp = call.isMcpCall ? true : false;
      if (isMcp) { totalMcpCalls += 1; mcpSuccess += ok; mcpErrors += err; } else { totalToolCalls += 1; toolSuccess += ok; toolErrors += err; }

      const tool = call.tool || "unknown";
      const isSkill = SKILL_PATTERNS.some(p => tool.toLowerCase().includes(p.toLowerCase()));
      if (isSkill) { totalSkillCalls += 1; skillSuccess += ok; skillErrors += err; }
      if (isSkill) {
        if (!bySkill[tool]) bySkill[tool] = { total: 0, success: 0, error: 0 };
        bySkill[tool].total += 1; bySkill[tool].success += ok; bySkill[tool].error += err;
      }

      const model = call.model || "unknown";
      if (!byModel[model]) byModel[model] = { total: 0, success: 0, error: 0, mcpCalls: 0, toolCalls: 0 };
      byModel[model].total += 1; byModel[model].success += ok; byModel[model].error += err;
      if (isMcp) byModel[model].mcpCalls += 1; else byModel[model].toolCalls += 1;

      const ts = call.timestamp || "";
      if (ts) {
        const hour = ts.substring(0, 13);
        const day = ts.substring(0, 10);
        if (!byTime.hourly[hour]) byTime.hourly[hour] = { total: 0, success: 0, error: 0 };
        byTime.hourly[hour].total += 1; byTime.hourly[hour].success += ok; byTime.hourly[hour].error += err;
        if (!byTime.daily[day]) byTime.daily[day] = { total: 0, success: 0, error: 0 };
        byTime.daily[day].total += 1; byTime.daily[day].success += ok; byTime.daily[day].error += err;
      }

      const mcpServer = call.mcpServer || (isMcp ? "unknown" : null);
      if (mcpServer) {
        if (!byMcpServer[mcpServer]) byMcpServer[mcpServer] = { total: 0, success: 0, error: 0, tools: {} };
        byMcpServer[mcpServer].total += 1; byMcpServer[mcpServer].success += ok; byMcpServer[mcpServer].error += err;
        const mcpTool = call.mcpToolName || call.tool || "unknown";
        if (!byMcpServer[mcpServer].tools[mcpTool]) byMcpServer[mcpServer].tools[mcpTool] = { total: 0, success: 0, error: 0 };
        byMcpServer[mcpServer].tools[mcpTool].total += 1; byMcpServer[mcpServer].tools[mcpTool].success += ok; byMcpServer[mcpServer].tools[mcpTool].error += err;
      }

      const toolName = call.tool || "unknown";
      if (!byTool[toolName]) byTool[toolName] = { total: 0, success: 0, error: 0 };
      byTool[toolName].total += 1; byTool[toolName].success += ok; byTool[toolName].error += err;

      const sid = call.sessionId || "unknown";
      if (!bySession[sid]) bySession[sid] = { total: 0, success: 0, error: 0, tools: {}, firstCall: call.timestamp || "", title: "" };
      bySession[sid].total += 1; bySession[sid].success += ok; bySession[sid].error += err;
      if (!bySession[sid].tools[tool]) bySession[sid].tools[tool] = 0;
      bySession[sid].tools[tool] += 1;
      if (call.timestamp && call.timestamp > (bySession[sid].firstCall || "")) bySession[sid].firstCall = call.timestamp;
    }

    for (const sid of Object.keys(bySession)) {
      const topTools = Object.entries(bySession[sid].tools).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([t]) => t);
      bySession[sid].title = topTools.join(" + ");
    }

    const errorRate = totalCalls > 0 ? (totalErrors / totalCalls * 100) : 0;

    const result = {
      totalCalls, totalMcpCalls, totalToolCalls, totalSkillCalls,
      totalSuccess, totalErrors, errorRate,
      mcpCalls: { total: totalMcpCalls, success: mcpSuccess, error: mcpErrors },
      toolCalls: { total: totalToolCalls, success: toolSuccess, error: toolErrors },
      skillCalls: { total: totalSkillCalls, success: skillSuccess, error: skillErrors },
      byModel, byTime, byMcpServer, byTool, bySkill, bySession,
      lastUpdated: callsData.lastUpdated,
    };

    return new Response(JSON.stringify(result), {
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}

export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });
}
