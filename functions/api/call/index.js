export async function onRequestPost({ request, env }) {
  try {
    const call = await request.json();

    if (!call || !call.callId) {
      return new Response(JSON.stringify({ error: "Missing required field: callId" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (!call.tool) {
      return new Response(JSON.stringify({ error: "Missing required field: tool" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const dataKey = "calls_data";
    const seenKey = "seen_call_ids";

    let callsData = await MCP_KV.get(dataKey, "json") || { calls: [], lastUpdated: null };
    let seenIds = await MCP_KV.get(seenKey, "json") || [];

    if (seenIds.includes(call.callId)) {
      return new Response(JSON.stringify({ ok: true, dedup: true }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    seenIds.push(call.callId);
    callsData.calls.push(call);
    callsData.lastUpdated = new Date().toISOString();

    // Keep max 5000 calls to avoid KV size limits
    if (callsData.calls.length > 5000) {
      callsData.calls = callsData.calls.slice(-5000);
      seenIds = callsData.calls.map(c => c.callId);
    }

    await MCP_KV.put(dataKey, JSON.stringify(callsData));
    await MCP_KV.put(seenKey, JSON.stringify(seenIds));

    return new Response(JSON.stringify({ ok: true, totalCalls: callsData.calls.length }), {
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
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });
}
