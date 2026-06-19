// Generate diverse test calls for both local and remote endpoints
const LOCAL = 'http://localhost:3210/api/call';
const REMOTE = 'https://mcp-call-monitor-dpdng7zv7tf9.edgeone.dev/api/call';

const models = ['claude-sonnet-4-20250514', 'gpt-4o', 'glm-5.1', 'deepseek-v3'];
const mcpServers = ['bilibili', 'echarts', 'playwright', 'notion', 'github'];
const mcpTools = {
  bilibili: ['search_videos', 'get_video_info', 'get_comments', 'check_credentials'],
  echarts: ['generate_bar_chart', 'generate_pie_chart', 'generate_line_chart', 'generate_heatmap'],
  playwright: ['navigate', 'click', 'screenshot', 'fill'],
  notion: ['search_pages', 'create_page', 'update_page', 'get_database'],
  github: ['create_issue', 'list_repos', 'search_code', 'get_pr'],
};
const builtinTools = ['Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'TodoWrite', 'WebFetch', 'Task', 'BackgroundOutput'];

const calls = [];
let id = 1000;

// Generate calls across different hours today
const now = new Date();
const hours = [];
for (let h = 8; h <= 23; h++) {
  hours.push(new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, Math.floor(Math.random() * 60)));
}

// MCP server calls - 40 calls across different servers
for (const server of mcpServers) {
  const tools = mcpTools[server];
  const count = 3 + Math.floor(Math.random() * 8); // 3-10 calls per server
  for (let i = 0; i < count; i++) {
    const tool = tools[Math.floor(Math.random() * tools.length)];
    const success = Math.random() > 0.15; // 85% success rate
    const hour = hours[Math.floor(Math.random() * hours.length)];
    calls.push({
      callId: `test-${id++}`,
      timestamp: hour.toISOString(),
      tool: `${server}_${tool}`,
      model: models[Math.floor(Math.random() * models.length)],
      isMcpCall: true,
      mcpServer: server,
      mcpToolName: tool,
      success,
      errorType: success ? null : ['timeout', 'network_error', 'auth_expired'][Math.floor(Math.random() * 3)],
    });
  }
}

// Builtin tool calls - 60 calls
for (const tool of builtinTools) {
  const count = 2 + Math.floor(Math.random() * 10);
  for (let i = 0; i < count; i++) {
    const success = Math.random() > 0.1; // 90% success
    const hour = hours[Math.floor(Math.random() * hours.length)];
    calls.push({
      callId: `test-${id++}`,
      timestamp: hour.toISOString(),
      tool: tool,
      model: models[Math.floor(Math.random() * models.length)],
      isMcpCall: false,
      mcpServer: null,
      mcpToolName: null,
      success,
      errorType: success ? null : 'permission_denied',
    });
  }
}

// Post to local
async function postLocal(call) {
  try {
    const res = await fetch(LOCAL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(call),
    });
    const data = await res.json();
    return data;
  } catch (e) {
    return { error: e.message };
  }
}

// Post to remote
async function postRemote(call) {
  try {
    const res = await fetch(REMOTE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(call),
    });
    const data = await res.json();
    return data;
  } catch (e) {
    return { error: e.message };
  }
}

async function main() {
  console.log(`Generating ${calls.length} test calls...`);

  let localOk = 0, localDedup = 0, localErr = 0;
  let remoteOk = 0, remoteDedup = 0, remoteErr = 0;

  // Send in batches of 10
  for (let i = 0; i < calls.length; i += 10) {
    const batch = calls.slice(i, i + 10);
    const promises = batch.map(async (call) => {
      const [localRes, remoteRes] = await Promise.all([
        postLocal(call),
        postRemote(call),
      ]);

      if (localRes.ok) localOk++;
      else if (localRes.dedup) localDedup++;
      else localErr++;

      if (remoteRes.ok) remoteOk++;
      else if (remoteRes.dedup) remoteDedup++;
      else remoteErr++;
    });

    await Promise.all(promises);
    process.stdout.write(`  Batch ${Math.floor(i / 10) + 1}/${Math.ceil(calls.length / 10)} sent\r`);
  }

  console.log(`\nDone!`);
  console.log(`  Local:  ${localOk} ok, ${localDedup} dedup, ${localErr} errors`);
  console.log(`  Remote: ${remoteOk} ok, ${remoteDedup} dedup, ${remoteErr} errors`);
}

main();
