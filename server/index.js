const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const PORT = 3210;
const DATA_FILE = path.join(__dirname, 'data.json');

// --- Data persistence ---

function readData() {
  try {
    if (!fs.existsSync(DATA_FILE)) {
      return { reports: [], calls: [], lastUpdated: null };
    }
    const raw = fs.readFileSync(DATA_FILE, 'utf-8');
    const data = JSON.parse(raw);
    // Backward compatibility: ensure calls array exists
    if (!data.calls) {
      data.calls = [];
    }
    return data;
  } catch (err) {
    console.error('Failed to read data file:', err.message);
    return { reports: [], calls: [], lastUpdated: null };
  }
}

function writeData(data) {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf-8');
  } catch (err) {
    console.error('Failed to write data file:', err.message);
  }
}

// --- SSE client management ---

const sseClients = new Set();
const seenCallIds = new Set();

const existingData = readData();
for (const call of existingData.calls) {
  if (call.callId) seenCallIds.add(call.callId);
}

function broadcast(data) {
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(payload);
    } catch {
      sseClients.delete(client);
    }
  }
}

// --- Express app ---

const app = express();

app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// --- POST /api/report — receive call data from MCP server ---

app.post('/api/report', (req, res) => {
  try {
    const report = req.body;

    if (!report || !report.sessionId) {
      return res.status(400).json({ error: 'Missing required field: sessionId' });
    }

    const data = readData();
    data.reports.push(report);
    data.lastUpdated = new Date().toISOString();
    writeData(data);

    // Notify SSE clients
    broadcast({ type: 'new_report', report, lastUpdated: data.lastUpdated });

    res.json({ ok: true, totalReports: data.reports.length });
  } catch (err) {
    console.error('POST /api/report error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// --- POST /api/call — receive individual call record from MCP server ---

app.post('/api/call', (req, res) => {
  try {
    const call = req.body;

    if (!call || !call.callId) {
      return res.status(400).json({ error: 'Missing required field: callId' });
    }
    if (!call.tool) {
      return res.status(400).json({ error: 'Missing required field: tool' });
    }
    if (!call.sessionId) {
      return res.status(400).json({ error: 'Missing required field: sessionId' });
    }

    const data = readData();
    if (seenCallIds.has(call.callId)) {
      return res.json({ ok: true, totalCalls: data.calls.length, dedup: true });
    }
    seenCallIds.add(call.callId);
    data.calls.push(call);
    data.lastUpdated = new Date().toISOString();
    writeData(data);

    broadcast({ type: 'new_call', call, lastUpdated: data.lastUpdated });

    res.json({ ok: true, totalCalls: data.calls.length });
  } catch (err) {
    console.error('POST /api/call error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// --- GET /api/stats — aggregated statistics ---

app.get('/api/stats', (req, res) => {
  try {
    const data = readData();

    const stats = {
      mcpCalls: { total: 0, success: 0, error: 0 },
      toolCalls: { total: 0, success: 0, error: 0 },
      totalErrors: 0,
      totalCalls: 0,
      errorRate: 0,
      lastUpdated: data.lastUpdated,
    };

    // Aggregate from reports (existing source)
    for (const report of data.reports) {
      if (report.mcpCalls) {
        stats.mcpCalls.total += report.mcpCalls.total || 0;
        stats.mcpCalls.success += report.mcpCalls.success || 0;
        stats.mcpCalls.error += report.mcpCalls.error || 0;
      }
      if (report.toolCalls) {
        stats.toolCalls.total += report.toolCalls.total || 0;
        stats.toolCalls.success += report.toolCalls.success || 0;
        stats.toolCalls.error += report.toolCalls.error || 0;
      }
      if (report.errors && Array.isArray(report.errors)) {
        stats.totalErrors += report.errors.length;
      }
    }

    // Aggregate from individual call records (new source)
    for (const call of data.calls) {
      stats.totalCalls += 1;
      if (call.isMcpCall) {
        stats.mcpCalls.total += 1;
        if (call.success) {
          stats.mcpCalls.success += 1;
        } else {
          stats.mcpCalls.error += 1;
          stats.totalErrors += 1;
        }
      } else {
        stats.toolCalls.total += 1;
        if (call.success) {
          stats.toolCalls.success += 1;
        } else {
          stats.toolCalls.error += 1;
          stats.totalErrors += 1;
        }
      }
    }

    // Compute error rate from total individual call records
    const combinedTotal = stats.mcpCalls.total + stats.toolCalls.total;
    if (combinedTotal > 0) {
      stats.errorRate = (stats.totalErrors / combinedTotal * 100);
    }

    res.json(stats);
  } catch (err) {
    console.error('GET /api/stats error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// --- GET /api/errors — flattened error list ---

app.get('/api/errors', (req, res) => {
  try {
    const data = readData();
    const errors = [];

    // Errors from reports (existing source)
    for (const report of data.reports) {
      if (report.errors && Array.isArray(report.errors)) {
        for (const err of report.errors) {
          errors.push({
            ...err,
            sessionId: err.sessionId || report.sessionId,
            reportTimestamp: report.timestamp,
          });
        }
      }
    }

    // Errors from individual call records where success=false
    for (const call of data.calls) {
      if (!call.success) {
        errors.push({
          sessionId: call.sessionId,
          mcpServer: call.mcpServer || 'unknown',
          toolName: call.mcpToolName || call.tool,
          errorMessage: call.errorMessage,
          errorType: call.errorType,
          timestamp: call.timestamp,
          callId: call.callId,
        });
      }
    }

    res.json(errors);
  } catch (err) {
    console.error('GET /api/errors error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// --- DELETE /api/errors — clear all stored data ---

app.delete('/api/errors', (req, res) => {
  try {
    writeData({ reports: [], calls: [], lastUpdated: new Date().toISOString() });
    broadcast({ type: 'data_cleared', lastUpdated: new Date().toISOString() });
    res.json({ ok: true, message: 'All data cleared' });
  } catch (err) {
    console.error('DELETE /api/errors error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// --- GET /api/calls — list all call records with optional filters ---

app.get('/api/calls', (req, res) => {
  try {
    const data = readData();
    let calls = data.calls || [];

    if (req.query.session) {
      calls = calls.filter(c => c.sessionId === req.query.session);
    }
    if (req.query.mcp === 'true') {
      calls = calls.filter(c => c.isMcpCall === true);
    }

    res.json({ calls, lastUpdated: data.lastUpdated || null });
  } catch (err) {
    console.error('GET /api/calls error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// --- GET /api/events — SSE endpoint for live updates ---

app.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  // Send initial keepalive
  res.write(':ok\n\n');

  sseClients.add(res);

  // Heartbeat every 30s to keep connection alive
  const heartbeat = setInterval(() => {
    try {
      res.write(':heartbeat\n\n');
    } catch {
      clearInterval(heartbeat);
      sseClients.delete(res);
    }
  }, 30000);

  req.on('close', () => {
    clearInterval(heartbeat);
    sseClients.delete(res);
  });
});

// --- Badge helpers ---

function computeStats() {
  const data = readData();
  const stats = {
    mcpCalls: { total: 0, success: 0, error: 0 },
    toolCalls: { total: 0, success: 0, error: 0 },
    totalErrors: 0,
  };

  for (const report of data.reports) {
    if (report.mcpCalls) {
      stats.mcpCalls.total += report.mcpCalls.total || 0;
      stats.mcpCalls.success += report.mcpCalls.success || 0;
      stats.mcpCalls.error += report.mcpCalls.error || 0;
    }
    if (report.toolCalls) {
      stats.toolCalls.total += report.toolCalls.total || 0;
      stats.toolCalls.success += report.toolCalls.success || 0;
      stats.toolCalls.error += report.toolCalls.error || 0;
    }
    if (report.errors && Array.isArray(report.errors)) {
      stats.totalErrors += report.errors.length;
    }
  }

  for (const call of data.calls || []) {
    if (call.isMcpCall) {
      stats.mcpCalls.total += 1;
      if (call.success) {
        stats.mcpCalls.success += 1;
      } else {
        stats.mcpCalls.error += 1;
        stats.totalErrors += 1;
      }
    } else {
      stats.toolCalls.total += 1;
      if (call.success) {
        stats.toolCalls.success += 1;
      } else {
        stats.toolCalls.error += 1;
        stats.totalErrors += 1;
      }
    }
  }

  return stats;
}

// Approximate text width for SVG badge layout (6px per char for 11px font)
function textWidth(str) {
  // CJK characters are wider (~12px), Latin ~6px at 11px font size
  let width = 0;
  for (const ch of str) {
    const code = ch.codePointAt(0);
    width += code >= 0x4e00 && code <= 0x9fff ? 12 : 6;
  }
  return width;
}

function makeBadge(label, value, color, style, theme) {
  const height = 20;
  const radius = style === 'flat' ? 0 : 3;
  const labelPad = 6;
  const valuePad = 6;
  const fontSize = 11;

  const isLight = theme === 'light';
  const labelBg = isLight ? '#e0e0ec' : '#3A3966';
  const textFill = isLight ? '#333355' : '#fff';

  const labelW = textWidth(label) + labelPad * 2;
  const valueW = textWidth(value) + valuePad * 2;
  const totalW = labelW + valueW;

  const labelX = labelW / 2;
  const valueX = labelW + valueW / 2;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${totalW}" height="${height}" viewBox="0 0 ${totalW} ${height}">
  <rect width="${labelW}" height="${height}" rx="${radius}" fill="${labelBg}"/>
  <rect x="${labelW}" width="${valueW}" height="${height}" rx="${radius}" fill="${color}"/>
  <rect width="${totalW}" height="${height}" rx="${radius}" fill="url(#badge-gradient)"/>
  <defs>
    <linearGradient id="badge-gradient" x2="0" y2="1">
      <stop offset="0%" stop-color="#fff" stop-opacity=".15"/>
      <stop offset="100%" stop-color="#fff" stop-opacity="0"/>
    </linearGradient>
    <clipPath id="badge-clip">
      <rect width="${totalW}" height="${height}" rx="${radius}"/>
    </clipPath>
  </defs>
  <g clip-path="url(#badge-clip)">
    <rect width="${labelW}" height="${height}" fill="${labelBg}"/>
    <rect x="${labelW}" width="${valueW}" height="${height}" fill="${color}"/>
    <rect width="${totalW}" height="${height}" fill="url(#badge-gradient)"/>
  </g>
  <g font-family="'Segoe UI',Arial,sans-serif" font-size="${fontSize}" font-weight="600" text-anchor="middle" fill="${textFill}">
    <text x="${labelX}" y="${height / 2 + 1}" dominant-baseline="central">${label}</text>
    <text x="${valueX}" y="${height / 2 + 1}" dominant-baseline="central">${value}</text>
  </g>
</svg>`;
}

function badgeResponse(res, svg) {
  res.writeHead(200, {
    'Content-Type': 'image/svg+xml',
    'Cache-Control': 'no-cache',
  });
  res.end(svg);
}

// --- Badge endpoints ---

app.get('/api/badge/mcp', (req, res) => {
  const stats = computeStats();
  const style = req.query.style === 'flat' ? 'flat' : 'rounded';
  const theme = req.query.theme === 'light' ? 'light' : 'dark';
  const value = `${stats.mcpCalls.total} ✓ ${stats.mcpCalls.error} ✗`;
  badgeResponse(res, makeBadge('MCP 调用', value, '#5470c6', style, theme));
});

app.get('/api/badge/tools', (req, res) => {
  const stats = computeStats();
  const style = req.query.style === 'flat' ? 'flat' : 'rounded';
  const theme = req.query.theme === 'light' ? 'light' : 'dark';
  const value = `${stats.toolCalls.total} ✓ ${stats.toolCalls.error} ✗`;
  badgeResponse(res, makeBadge('工具调用', value, '#9a60b4', style, theme));
});

app.get('/api/badge/errors', (req, res) => {
  const stats = computeStats();
  const style = req.query.style === 'flat' ? 'flat' : 'rounded';
  const theme = req.query.theme === 'light' ? 'light' : 'dark';
  const errCount = stats.totalErrors;
  const color = errCount === 0 ? '#91cc75' : errCount <= 5 ? '#fac858' : '#ee6666';
  badgeResponse(res, makeBadge('错误数', String(errCount), color, style, theme));
});

app.get('/api/badge/summary', (req, res) => {
  const stats = computeStats();
  const style = req.query.style === 'flat' ? 'flat' : 'rounded';
  const theme = req.query.theme === 'light' ? 'light' : 'dark';
  const value = `MCP:${stats.mcpCalls.success}✓ ${stats.mcpCalls.error}✗ | Tools:${stats.toolCalls.success}✓ ${stats.toolCalls.error}✗ | Err:${stats.totalErrors}`;
  badgeResponse(res, makeBadge('监控概览', value, '#73c0de', style, theme));
});

// --- Start server ---

app.listen(PORT, () => {
  console.log(`MCP Call Monitor server running on http://localhost:${PORT}`);
  console.log(`Data file: ${DATA_FILE}`);
});
