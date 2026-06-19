export async function onRequestGet({ request }) {
  try {
    const dataKey = "calls_data";
    const callsData = await MCP_KV.get(dataKey, "json") || { calls: [], lastUpdated: null };

    return new Response(JSON.stringify({ calls: callsData.calls || [], lastUpdated: callsData.lastUpdated }), {
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
