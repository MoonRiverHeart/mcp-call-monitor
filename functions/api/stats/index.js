export async function onRequestGet({ request, env }) {
  try {
    const dataKey = "calls_data";
    const callsData = await env.MCP_KV.get(dataKey, "json") || { calls: [], lastUpdated: null };

    const calls = callsData.calls || [];
    const byModel = {};
    const byTime = { hourly: {}, daily: {} };
    const byMcpServer = {};
    const byTool = {};
    let totalCalls = 0, totalMcpCalls = 0, totalToolCalls = 0;
    let totalSuccess = 0, totalErrors = 0;

    for (const call of calls) {
      totalCalls += 1;
      const ok = call.success ? 1 : 0;
      const err = call.success ? 0 : 1;
      totalSuccess += ok;
      totalErrors += err;
      const isMcp = call.isMcpCall ? true : false;
      if (isMcp) totalMcpCalls += 1; else totalToolCalls += 1;

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

      const tool = call.tool || "unknown";
      if (!byTool[tool]) byTool[tool] = { total: 0, success: 0, error: 0 };
      byTool[tool].total += 1; byTool[tool].success += ok; byTool[tool].error += err;
    }

    const errorRate = totalCalls > 0 ? (totalErrors / totalCalls * 100) : 0;

    const result = {
      totalCalls, totalMcpCalls, totalToolCalls, totalSuccess, totalErrors, errorRate,
      byModel, byTime, byMcpServer, byTool,
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
