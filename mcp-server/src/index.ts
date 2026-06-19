import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Types (matching Express server /api/stats response shape)
// ---------------------------------------------------------------------------

interface ModelStats {
  total: number;
  success: number;
  error: number;
  mcpCalls: number;
  toolCalls: number;
}

interface TimeBucketStats {
  total: number;
  success: number;
  error: number;
}

interface McpServerStats {
  total: number;
  success: number;
  error: number;
  tools: Record<string, TimeBucketStats>;
}

interface ToolStats {
  total: number;
  success: number;
  error: number;
}

interface StatsResponse {
  totalCalls: number;
  totalMcpCalls: number;
  totalToolCalls: number;
  totalSuccess: number;
  totalErrors: number;
  errorRate: number;
  byModel: Record<string, ModelStats>;
  byTime: {
    hourly: Record<string, TimeBucketStats>;
    daily: Record<string, TimeBucketStats>;
  };
  byMcpServer: Record<string, McpServerStats>;
  byTool: Record<string, ToolStats>;
  lastUpdated: string | null;
}

interface ErrorRecord {
  sessionId: string;
  mcpServer: string;
  toolName: string;
  errorMessage: string;
  errorType: string;
  llmAnalysis: string;
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const KNOWN_ERROR_PATTERNS: Array<{ pattern: RegExp; type: string }> = [
  { pattern: /timeout|timed out|ETIMEDOUT/i, type: "timeout" },
  { pattern: /permission|access denied|EACCES/i, type: "permission_denied" },
  { pattern: /network|ECONNREFUSED|ENOTFOUND|fetch failed/i, type: "network_error" },
  { pattern: /invalid|parse|format|schema/i, type: "invalid_response" },
  { pattern: /auth|cookie|token|credential|expired|login/i, type: "auth_expired" },
];

const DEFAULT_DASHBOARD_URL = "http://localhost:3210";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function classifyError(errorMessage: string): string {
  for (const { pattern, type } of KNOWN_ERROR_PATTERNS) {
    if (pattern.test(errorMessage)) {
      return type;
    }
  }
  return "unknown";
}

function generatePatternAnalysis(
  mcpServer: string,
  toolName: string,
  errorMessage: string,
  errorType: string,
): string {
  const suggestions: Record<string, string> = {
    timeout:
      "The MCP tool call timed out. This may indicate the MCP server is unresponsive, " +
      "the tool is performing a long-running operation, or there is a network latency issue. " +
      "Suggested fix: Check that the MCP server is running and responsive. Consider increasing " +
      "timeout settings or retrying the operation.",
    permission_denied:
      "The MCP tool call was denied due to insufficient permissions. " +
      "Suggested fix: Verify that the MCP server has the necessary file system or resource " +
      "access permissions. Check OpenCode's permission rules in opencode.json.",
    network_error:
      "A network-level error occurred during the MCP tool call. " +
      "Suggested fix: Verify network connectivity. Check that any required remote services " +
      "are reachable. If the MCP server connects to external APIs, ensure those endpoints are accessible.",
    invalid_response:
      "The MCP server returned an invalid or unparseable response. " +
      "Suggested fix: Verify that the MCP server implementation returns valid responses " +
      "matching the expected schema. Check for version mismatches between the MCP SDK and server.",
    auth_expired:
      "An authentication or credential error occurred. " +
      "Suggested fix: Check that API keys, tokens, or cookies configured for this MCP server " +
      "are still valid and have not expired. Update credentials in the MCP server configuration.",
    unknown:
      "An unrecognized error occurred. " +
      "Suggested fix: Review the full error message for details. Check the MCP server logs " +
      "for additional context. Verify the MCP server is properly configured and running.",
  };

  const suggestion = suggestions[errorType] ?? suggestions["unknown"]!;

  return (
    `Error Type: ${errorType}\n` +
    `MCP Server: ${mcpServer}\n` +
    `Tool: ${toolName}\n` +
    `Error: ${errorMessage}\n\n` +
    `Analysis: ${suggestion}`
  );
}

async function generateLlmAnalysis(
  mcpServer: string,
  toolName: string,
  errorMessage: string,
): Promise<string | null> {
  const apiUrl = process.env["LLM_API_URL"];
  const apiKey = process.env["LLM_API_KEY"];
  const model = process.env["LLM_MODEL"] ?? "gpt-4o-mini";

  if (!apiUrl || !apiKey) {
    return null;
  }

  try {
    const response = await fetch(apiUrl + "/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: "user",
            content:
              `Analyze this MCP tool call error and provide a brief diagnosis with suggested fix. ` +
              `MCP server: ${mcpServer}, Tool: ${toolName}, Error: ${errorMessage}`,
          },
        ],
        max_tokens: 300,
        temperature: 0.3,
      }),
    });

    if (!response.ok) {
      console.error(`LLM API returned ${response.status}: ${await response.text()}`);
      return null;
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content;
    return content ?? null;
  } catch (err) {
    console.error("LLM API call failed:", err);
    return null;
  }
}

function getServerUrl(override?: string): string {
  return override ?? process.env["DASHBOARD_URL"] ?? DEFAULT_DASHBOARD_URL;
}

async function fetchStats(serverUrl: string): Promise<StatsResponse | null> {
  try {
    const response = await fetch(`${serverUrl}/api/stats`, {
      headers: { "Content-Type": "application/json" },
    });
    if (!response.ok) return null;
    return (await response.json()) as StatsResponse;
  } catch {
    return null;
  }
}

async function fetchErrors(serverUrl: string): Promise<ErrorRecord[]> {
  try {
    const response = await fetch(`${serverUrl}/api/errors`, {
      headers: { "Content-Type": "application/json" },
    });
    if (!response.ok) return [];
    const data = await response.json();
    if (Array.isArray(data)) return data as ErrorRecord[];
    const wrapped = (data as Record<string, unknown>)["errors"];
    if (Array.isArray(wrapped)) return wrapped as ErrorRecord[];
    return [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Tool input schemas
// ---------------------------------------------------------------------------

const CollectStatsSchema = z.object({
  serverUrl: z.string().optional(),
});

const AnalyzeErrorSchema = z.object({
  errorMessage: z.string(),
  mcpServer: z.string(),
  toolName: z.string(),
});

const UploadReportSchema = z.object({
  stats: z.object({
    totalCalls: z.number(),
    totalMcpCalls: z.number(),
    totalToolCalls: z.number(),
    totalSuccess: z.number(),
    totalErrors: z.number(),
  }),
  errors: z.array(
    z.object({
      mcpServer: z.string(),
      toolName: z.string(),
      errorMessage: z.string(),
      errorType: z.string(),
      llmAnalysis: z.string().optional(),
      timestamp: z.string().optional(),
    }),
  ),
  serverUrl: z.string().optional(),
});

const FullScanSchema = z.object({
  serverUrl: z.string().optional(),
});

const TrendsSchema = z.object({
  hours: z.number().optional(),
  groupBy: z.enum(["hour", "day"]).optional(),
  serverUrl: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Server setup
// ---------------------------------------------------------------------------

const server = new Server(
  {
    name: "mcp-call-monitor",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

// ---------------------------------------------------------------------------
// Tool handlers
// ---------------------------------------------------------------------------

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "mcp_monitor_collect_stats",
        description:
          "Fetches aggregated MCP/tool call statistics from the Express server's /api/stats endpoint. " +
          "Returns total counts, error rate, breakdowns by model, time, MCP server, and tool. " +
          "No session-based aggregation — all data is server-wide.",
        inputSchema: {
          type: "object",
          properties: {
            serverUrl: {
              type: "string",
              description:
                "Optional Express server URL. Defaults to http://localhost:3210 or DASHBOARD_URL env var.",
            },
          },
        },
      },
      {
        name: "mcp_monitor_analyze_error",
        description:
          "Takes error details from an MCP tool call, classifies the error type, " +
          "and optionally generates an LLM-powered analysis. " +
          "Classification is pattern-based: timeout, permission_denied, network_error, " +
          "invalid_response, auth_expired, or unknown. " +
          "If LLM_API_URL and LLM_API_KEY environment variables are configured, " +
          "it also calls an OpenAI-compatible API for deeper analysis.",
        inputSchema: {
          type: "object",
          properties: {
            errorMessage: {
              type: "string",
              description: "The error message from the MCP tool call.",
            },
            mcpServer: {
              type: "string",
              description: "The name of the MCP server that produced the error.",
            },
            toolName: {
              type: "string",
              description: "The name of the tool that was called.",
            },
          },
          required: ["errorMessage", "mcpServer", "toolName"],
        },
      },
      {
        name: "mcp_monitor_upload_report",
        description:
          "Uploads collected MCP call statistics and error data to the backend dashboard server. " +
          "Makes an HTTP POST request to {serverUrl}/api/report with the stats and errors payload. " +
          "The stats parameter uses the new flat shape (totalCalls, totalMcpCalls, etc.). " +
          "The default server URL is http://localhost:3210, overridable via the serverUrl parameter " +
          "or the DASHBOARD_URL environment variable.",
        inputSchema: {
          type: "object",
          properties: {
            stats: {
              type: "object",
              properties: {
                totalCalls: { type: "number" },
                totalMcpCalls: { type: "number" },
                totalToolCalls: { type: "number" },
                totalSuccess: { type: "number" },
                totalErrors: { type: "number" },
              },
              required: ["totalCalls", "totalMcpCalls", "totalToolCalls", "totalSuccess", "totalErrors"],
            },
            errors: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  mcpServer: { type: "string" },
                  toolName: { type: "string" },
                  errorMessage: { type: "string" },
                  errorType: { type: "string" },
                  llmAnalysis: { type: "string" },
                  timestamp: { type: "string" },
                },
                required: ["mcpServer", "toolName", "errorMessage", "errorType"],
              },
            },
            serverUrl: {
              type: "string",
              description:
                "Optional backend server URL. Defaults to http://localhost:3210 or DASHBOARD_URL env var.",
            },
          },
          required: ["stats", "errors"],
        },
      },
      {
        name: "mcp_monitor_full_scan",
        description:
          "Performs a complete monitoring scan in one call: fetches aggregated stats from the Express server, " +
          "fetches and analyzes errors, and uploads the report. " +
          "Combines collect_stats, analyze_error (for each error), and upload_report into a single operation.",
        inputSchema: {
          type: "object",
          properties: {
            serverUrl: {
              type: "string",
              description:
                "Optional Express server URL. Defaults to http://localhost:3210 or DASHBOARD_URL env var.",
            },
          },
        },
      },
      {
        name: "mcp_monitor_trends",
        description:
          "Performs time-series and error-rate trend analysis of MCP/tool calls. " +
          "Fetches pre-aggregated time buckets from the Express server's /api/stats byTime field, " +
          "filters by lookback period, and computes per-bucket metrics including call counts, " +
          "error rates, and summary statistics with peak hours and average call rates.",
        inputSchema: {
          type: "object",
          properties: {
            hours: {
              type: "number",
              description:
                "Lookback period in hours. Defaults to 24.",
            },
            groupBy: {
              type: "string",
              enum: ["hour", "day"],
              description:
                "Time grouping for trend buckets. Defaults to 'hour'.",
            },
            serverUrl: {
              type: "string",
              description:
                "Optional Express server URL. Defaults to http://localhost:3210 or DASHBOARD_URL env var.",
            },
          },
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  switch (name) {
    // -----------------------------------------------------------------------
    // mcp_monitor_collect_stats
    // -----------------------------------------------------------------------
    case "mcp_monitor_collect_stats": {
      const parsed = CollectStatsSchema.parse(args ?? {});
      const serverUrl = getServerUrl(parsed.serverUrl);

      const stats = await fetchStats(serverUrl);

      if (!stats) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  source: "none",
                  message:
                    "Express server unreachable at " + serverUrl + "/api/stats. " +
                    "Ensure the server is running on port 3210.",
                  totalCalls: 0,
                  totalMcpCalls: 0,
                  totalToolCalls: 0,
                  totalSuccess: 0,
                  totalErrors: 0,
                  errorRate: 0,
                  byModel: {},
                  byTime: { hourly: {}, daily: {} },
                  byMcpServer: {},
                  byTool: {},
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                source: "express_server",
                totalCalls: stats.totalCalls,
                totalMcpCalls: stats.totalMcpCalls,
                totalToolCalls: stats.totalToolCalls,
                totalSuccess: stats.totalSuccess,
                totalErrors: stats.totalErrors,
                errorRate: stats.errorRate,
                byModel: stats.byModel,
                byTime: stats.byTime,
                byMcpServer: stats.byMcpServer,
                byTool: stats.byTool,
                lastUpdated: stats.lastUpdated,
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    // -----------------------------------------------------------------------
    // mcp_monitor_analyze_error
    // -----------------------------------------------------------------------
    case "mcp_monitor_analyze_error": {
      const parsed = AnalyzeErrorSchema.parse(args ?? {});
      const errorType = classifyError(parsed.errorMessage);

      // Try LLM analysis first
      let llmAnalysis = await generateLlmAnalysis(
        parsed.mcpServer,
        parsed.toolName,
        parsed.errorMessage,
      );

      // Fall back to pattern-based analysis
      if (!llmAnalysis) {
        llmAnalysis = generatePatternAnalysis(
          parsed.mcpServer,
          parsed.toolName,
          parsed.errorMessage,
          errorType,
        );
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                errorType,
                llmAnalysis,
                llmUsed: process.env["LLM_API_KEY"] ? true : false,
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    // -----------------------------------------------------------------------
    // mcp_monitor_upload_report
    // -----------------------------------------------------------------------
    case "mcp_monitor_upload_report": {
      const parsed = UploadReportSchema.parse(args ?? {});
      const serverUrl = getServerUrl(parsed.serverUrl);

      // Transform new flat stats shape to Express server /api/report format
      const payload = {
        sessionId: `upload-${Date.now()}`,
        timestamp: new Date().toISOString(),
        mcpCalls: {
          total: parsed.stats.totalMcpCalls,
          success: 0,
          error: 0,
        },
        toolCalls: {
          total: parsed.stats.totalToolCalls,
          success: 0,
          error: 0,
        },
        errors: parsed.errors.map((e) => ({
          sessionId: "upload",
          mcpServer: e.mcpServer,
          toolName: e.toolName,
          errorMessage: e.errorMessage,
          errorType: e.errorType,
          llmAnalysis: e.llmAnalysis ?? "",
          timestamp: e.timestamp ?? new Date().toISOString(),
        })),
      };

      try {
        const response = await fetch(`${serverUrl}/api/report`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });

        if (!response.ok) {
          const errorText = await response.text();
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    success: false,
                    message: `Server returned ${response.status}: ${errorText}`,
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        }

        const result = (await response.json()) as { ok?: boolean; totalReports?: number };

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: true,
                  message: `Report uploaded successfully. Total reports on server: ${result.totalReports ?? "unknown"}`,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: false,
                  message: `Failed to upload report: ${errorMessage}`,
                },
                null,
                2,
              ),
            },
          ],
        };
      }
    }

    // -----------------------------------------------------------------------
    // mcp_monitor_full_scan
    // -----------------------------------------------------------------------
    case "mcp_monitor_full_scan": {
      const parsed = FullScanSchema.parse(args ?? {});
      const serverUrl = getServerUrl(parsed.serverUrl);

      // Step 1: Fetch stats from Express server
      const stats = await fetchStats(serverUrl);

      if (!stats) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  source: "none",
                  message: "Express server unreachable. Cannot perform full scan.",
                  totalCalls: 0,
                  totalMcpCalls: 0,
                  totalToolCalls: 0,
                  totalSuccess: 0,
                  totalErrors: 0,
                  errorRate: 0,
                  byModel: {},
                  byTime: { hourly: {}, daily: {} },
                  byMcpServer: {},
                  byTool: {},
                  errors: [],
                  uploaded: false,
                  uploadMessage: "Server unreachable, no upload attempted.",
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      // Step 2: Fetch errors and analyze each one
      const rawErrors = await fetchErrors(serverUrl);
      const analyzedErrors: ErrorRecord[] = [];

      for (const err of rawErrors) {
        const errorType = err.errorType || classifyError(err.errorMessage);

        let llmAnalysis = await generateLlmAnalysis(
          err.mcpServer,
          err.toolName,
          err.errorMessage,
        );

        if (!llmAnalysis) {
          llmAnalysis = generatePatternAnalysis(
            err.mcpServer,
            err.toolName,
            err.errorMessage,
            errorType,
          );
        }

        analyzedErrors.push({
          ...err,
          errorType,
          llmAnalysis,
        });
      }

      // Step 3: Upload report
      const payload = {
        sessionId: `full-scan-${Date.now()}`,
        timestamp: new Date().toISOString(),
        mcpCalls: {
          total: stats.totalMcpCalls,
          success: 0,
          error: 0,
        },
        toolCalls: {
          total: stats.totalToolCalls,
          success: 0,
          error: 0,
        },
        errors: analyzedErrors,
      };

      let uploaded = false;
      let uploadMessage = "";

      try {
        const response = await fetch(`${serverUrl}/api/report`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });

        if (response.ok) {
          uploaded = true;
          uploadMessage = "Report uploaded successfully";
        } else {
          uploadMessage = `Upload failed: server returned ${response.status}`;
        }
      } catch (err) {
        uploadMessage = `Upload failed: ${err instanceof Error ? err.message : String(err)}`;
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                source: "express_server",
                totalCalls: stats.totalCalls,
                totalMcpCalls: stats.totalMcpCalls,
                totalToolCalls: stats.totalToolCalls,
                totalSuccess: stats.totalSuccess,
                totalErrors: stats.totalErrors,
                errorRate: stats.errorRate,
                byModel: stats.byModel,
                byTime: stats.byTime,
                byMcpServer: stats.byMcpServer,
                byTool: stats.byTool,
                errors: analyzedErrors,
                uploaded,
                uploadMessage,
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    // -----------------------------------------------------------------------
    // mcp_monitor_trends
    // -----------------------------------------------------------------------
    case "mcp_monitor_trends": {
      const parsed = TrendsSchema.parse(args ?? {});
      const hours = parsed.hours ?? 24;
      const groupBy = parsed.groupBy ?? "hour";
      const serverUrl = getServerUrl(parsed.serverUrl);

      const stats = await fetchStats(serverUrl);

      if (!stats) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: false,
                  message: `Failed to fetch stats from Express server at ${serverUrl}/api/stats.`,
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      // Select hourly or daily buckets from byTime
      const buckets = groupBy === "day" ? stats.byTime.daily : stats.byTime.hourly;

      // Filter buckets by lookback period
      const now = Date.now();
      const cutoff = now - hours * 60 * 60 * 1000;

      const filteredBuckets: Array<{
        timeBucket: string;
        total: number;
        success: number;
        error: number;
        errorRate: number;
      }> = [];

      for (const [key, bucketStats] of Object.entries(buckets)) {
        // Parse bucket key as a date for filtering
        // Hourly keys: "2026-06-19T10" → parse as ISO date
        // Daily keys: "2026-06-19" → parse as ISO date
        let bucketDate: Date;
        try {
          if (groupBy === "day") {
            bucketDate = new Date(key + "T00:00:00Z");
          } else {
            bucketDate = new Date(key + ":00:00Z");
          }
        } catch {
          continue;
        }

        if (bucketDate.getTime() < cutoff) continue;

        const total = bucketStats.total;
        const errorRate = total > 0 ? (bucketStats.error / total) * 100 : 0;

        filteredBuckets.push({
          timeBucket: key,
          total: bucketStats.total,
          success: bucketStats.success,
          error: bucketStats.error,
          errorRate,
        });
      }

      // Sort by timeBucket ascending
      filteredBuckets.sort((a, b) => a.timeBucket.localeCompare(b.timeBucket));

      // Compute overall summary from filtered buckets
      const totalCalls = filteredBuckets.reduce((sum, b) => sum + b.total, 0);
      const totalSuccess = filteredBuckets.reduce((sum, b) => sum + b.success, 0);
      const totalErrors = filteredBuckets.reduce((sum, b) => sum + b.error, 0);
      const overallErrorRate = totalCalls > 0 ? (totalErrors / totalCalls) * 100 : 0;

      let peakBucket = "";
      let peakBucketCalls = 0;
      let peakErrorBucket = "";
      let peakErrorBucketErrors = 0;

      for (const bucket of filteredBuckets) {
        if (bucket.total > peakBucketCalls) {
          peakBucketCalls = bucket.total;
          peakBucket = bucket.timeBucket;
        }
        if (bucket.error > peakErrorBucketErrors) {
          peakErrorBucketErrors = bucket.error;
          peakErrorBucket = bucket.timeBucket;
        }
      }

      const bucketCount = filteredBuckets.length;
      const averageCallsPerHour =
        bucketCount > 0 ? totalCalls / (groupBy === "day" ? hours / 24 : hours) : 0;

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                trends: filteredBuckets,
                summary: {
                  totalCalls,
                  totalSuccess,
                  totalErrors,
                  overallErrorRate,
                  peakBucket,
                  peakErrorBucket,
                  averageCallsPerHour,
                },
                source: "express_server",
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("MCP Call Monitor server running on stdio");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
