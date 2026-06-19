import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import fs from "fs";
import path from "path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface McpCallCounts {
  total: number;
  success: number;
  error: number;
}

interface ToolCallCounts {
  total: number;
  success: number;
  error: number;
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

interface SessionStats {
  mcpCalls: McpCallCounts;
  toolCalls: ToolCallCounts;
  errors: ErrorRecord[];
}

interface UploadPayload {
  sessionId: string;
  timestamp: string;
  mcpCalls: McpCallCounts;
  toolCalls: ToolCallCounts;
  errors: ErrorRecord[];
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

function findSessionFiles(): string[] {
  const possibleDirs: string[] = [];

  // Windows paths
  const appData = process.env["APPDATA"];
  const localAppData = process.env["LOCALAPPDATA"];
  const userProfile = process.env["USERPROFILE"];

  if (appData) {
    possibleDirs.push(`${appData}\\opencode`);
    possibleDirs.push(`${appData}\\opencode\\sessions`);
  }
  if (localAppData) {
    possibleDirs.push(`${localAppData}\\opencode`);
    possibleDirs.push(`${localAppData}\\opencode\\sessions`);
  }
  if (userProfile) {
    possibleDirs.push(`${userProfile}\\.opencode`);
    possibleDirs.push(`${userProfile}\\.opencode\\sessions`);
  }

  // Also check common non-Windows paths (for cross-platform compatibility)
  const home = process.env["HOME"];
  if (home) {
    possibleDirs.push(`${home}/.opencode`);
    possibleDirs.push(`${home}/.opencode/sessions`);
    possibleDirs.push(`${home}/Library/Application Support/opencode`);
    possibleDirs.push(`${home}/Library/Application Support/opencode/sessions`);
  }

  const results: string[] = [];

  for (const dir of possibleDirs) {
    try {
      if (fs.existsSync(dir)) {
        const entries = fs.readdirSync(dir);
        for (const entry of entries) {
          const fullPath = path.join(dir, entry);
          const stat = fs.statSync(fullPath);
          if (stat.isFile() && (entry.endsWith(".json") || !entry.includes("."))) {
            results.push(fullPath);
          }
        }
      }
    } catch {
      // skip directories we cannot read
    }
  }

  return results;
}

function parseSessionFile(sessionFilePath: string): SessionStats | null {
  try {
    const raw = fs.readFileSync(sessionFilePath, "utf-8");
    const data = JSON.parse(raw) as Record<string, unknown>;

    const sessionId: string =
      (data["sessionId"] as string | undefined) ??
      (data["id"] as string | undefined) ??
      (data["session_id"] as string | undefined) ??
      path.basename(sessionFilePath, path.extname(sessionFilePath));

    const mcpCalls: McpCallCounts = { total: 0, success: 0, error: 0 };
    const toolCalls: ToolCallCounts = { total: 0, success: 0, error: 0 };
    const errors: ErrorRecord[] = [];

    // Try to extract tool call info from messages array
    const messages: unknown[] =
      (data["messages"] as unknown[] | undefined) ??
      (data["log"] as unknown[] | undefined) ??
      (data["events"] as unknown[] | undefined) ??
      [];

    for (const msg of messages) {
      if (typeof msg !== "object" || msg === null) continue;

      const record = msg as Record<string, unknown>;

      // Check for tool call messages
      const content =
        record["content"] ?? record["text"] ?? record["message"] ?? "";
      const contentStr = typeof content === "string" ? content : JSON.stringify(content);

      const toolName: string | undefined =
        (record["toolName"] as string | undefined) ??
        (record["tool"] as string | undefined) ??
        (record["name"] as string | undefined) ??
        (record["function"] as string | undefined);

      const mcpServer: string | undefined =
        (record["mcpServer"] as string | undefined) ??
        (record["server"] as string | undefined) ??
        (record["source"] as string | undefined);

      const isError =
        record["error"] !== undefined ||
        record["level"] === "error" ||
        record["status"] === "error" ||
        /error|fail|invalid/i.test(contentStr);

      if (toolName || contentStr.includes("tool_call") || contentStr.includes("mcp_")) {
        toolCalls.total++;
        if (isError) {
          toolCalls.error++;
        } else {
          toolCalls.success++;
        }
      }

      if (mcpServer || contentStr.includes("mcp_")) {
        mcpCalls.total++;
        if (isError) {
          mcpCalls.error++;
        } else {
          mcpCalls.success++;
        }
      }

      // Extract error details
      if (isError) {
        const errorMessage: string =
          (record["errorMessage"] as string) ??
          (record["error"] as string) ??
          (record["message"] as string) ??
          contentStr;

        const errorType = classifyError(errorMessage);

        errors.push({
          sessionId,
          mcpServer: mcpServer ?? "unknown",
          toolName: toolName ?? "unknown",
          errorMessage,
          errorType,
          llmAnalysis: "",
          timestamp: (record["timestamp"] as string) ?? new Date().toISOString(),
        });
      }
    }

    return { mcpCalls, toolCalls, errors };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Tool input schemas
// ---------------------------------------------------------------------------

const CollectStatsSchema = z.object({
  sessionPath: z.string().optional(),
  sessionData: z
    .array(
      z.object({
        sessionId: z.string().optional(),
        mcpCalls: z
          .object({
            total: z.number().optional(),
            success: z.number().optional(),
            error: z.number().optional(),
          })
          .optional(),
        toolCalls: z
          .object({
            total: z.number().optional(),
            success: z.number().optional(),
            error: z.number().optional(),
          })
          .optional(),
        errors: z
          .array(
            z.object({
              mcpServer: z.string().optional(),
              toolName: z.string().optional(),
              errorMessage: z.string().optional(),
              errorType: z.string().optional(),
              timestamp: z.string().optional(),
            }),
          )
          .optional(),
      }),
    )
    .optional(),
});

const AnalyzeErrorSchema = z.object({
  errorMessage: z.string(),
  mcpServer: z.string(),
  toolName: z.string(),
});

const UploadReportSchema = z.object({
  stats: z.object({
    mcpCalls: z.object({
      total: z.number(),
      success: z.number(),
      error: z.number(),
    }),
    toolCalls: z.object({
      total: z.number(),
      success: z.number(),
      error: z.number(),
    }),
  }),
  errors: z.array(
    z.object({
      sessionId: z.string().optional(),
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
  sessionData: z
    .array(
      z.object({
        sessionId: z.string().optional(),
        mcpCalls: z
          .object({
            total: z.number().optional(),
            success: z.number().optional(),
            error: z.number().optional(),
          })
          .optional(),
        toolCalls: z
          .object({
            total: z.number().optional(),
            success: z.number().optional(),
            error: z.number().optional(),
          })
          .optional(),
        errors: z
          .array(
            z.object({
              mcpServer: z.string().optional(),
              toolName: z.string().optional(),
              errorMessage: z.string().optional(),
              errorType: z.string().optional(),
              timestamp: z.string().optional(),
            }),
          )
          .optional(),
      }),
    )
    .optional(),
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
          "Scans OpenCode session data and collects all MCP/tool call statistics. " +
          "Attempts to auto-discover session files from the OpenCode data directory. " +
          "If no session files are found, pass session data via the sessionData parameter. " +
          "Returns structured stats including total/success/error counts for MCP calls and tool calls.",
        inputSchema: {
          type: "object",
          properties: {
            sessionPath: {
              type: "string",
              description:
                "Optional path to a specific session file or directory. If omitted, auto-discovers from OpenCode data directories.",
            },
            sessionData: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  sessionId: { type: "string" },
                  mcpCalls: {
                    type: "object",
                    properties: {
                      total: { type: "number" },
                      success: { type: "number" },
                      error: { type: "number" },
                    },
                  },
                  toolCalls: {
                    type: "object",
                    properties: {
                      total: { type: "number" },
                      success: { type: "number" },
                      error: { type: "number" },
                    },
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
                        timestamp: { type: "string" },
                      },
                    },
                  },
                },
              },
              description:
                "Optional array of session data objects. Use this when auto-discovery finds no files.",
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
          "The default server URL is http://localhost:3210, overridable via the serverUrl parameter " +
          "or the DASHBOARD_URL environment variable.",
        inputSchema: {
          type: "object",
          properties: {
            stats: {
              type: "object",
              properties: {
                mcpCalls: {
                  type: "object",
                  properties: {
                    total: { type: "number" },
                    success: { type: "number" },
                    error: { type: "number" },
                  },
                  required: ["total", "success", "error"],
                },
                toolCalls: {
                  type: "object",
                  properties: {
                    total: { type: "number" },
                    success: { type: "number" },
                    error: { type: "number" },
                  },
                  required: ["total", "success", "error"],
                },
              },
              required: ["mcpCalls", "toolCalls"],
            },
            errors: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  sessionId: { type: "string" },
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
          "Performs a complete monitoring scan in one call: collects MCP/tool call statistics " +
          "from sessions, detects and analyzes errors, and uploads the report to the backend server. " +
          "Combines collect_stats, analyze_error (for each error), and upload_report into a single operation. " +
          "Attempts auto-discovery of session files first; if none found, pass sessionData parameter.",
        inputSchema: {
          type: "object",
          properties: {
            serverUrl: {
              type: "string",
              description:
                "Optional backend server URL. Defaults to http://localhost:3210 or DASHBOARD_URL env var.",
            },
            sessionData: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  sessionId: { type: "string" },
                  mcpCalls: {
                    type: "object",
                    properties: {
                      total: { type: "number" },
                      success: { type: "number" },
                      error: { type: "number" },
                    },
                  },
                  toolCalls: {
                    type: "object",
                    properties: {
                      total: { type: "number" },
                      success: { type: "number" },
                      error: { type: "number" },
                    },
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
                        timestamp: { type: "string" },
                      },
                    },
                  },
                },
              },
              description:
                "Optional array of session data. Use when auto-discovery finds no files.",
            },
          },
        },
      },
      {
        name: "mcp_monitor_trends",
        description:
          "Performs time-series and error-rate trend analysis of MCP/tool calls. " +
          "Fetches call records from the Express server, filters by lookback period, " +
          "groups into time buckets (hour or day), and computes per-bucket metrics " +
          "including call counts, error rates, top error types, and top failing tools. " +
          "Also returns an overall summary with peak hours and average call rates.",
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

      const aggregated: SessionStats = {
        mcpCalls: { total: 0, success: 0, error: 0 },
        toolCalls: { total: 0, success: 0, error: 0 },
        errors: [],
      };

      // Try filesystem discovery
      if (!parsed.sessionPath && !parsed.sessionData) {
        const sessionFiles = findSessionFiles();

        if (sessionFiles.length > 0) {
          for (const file of sessionFiles) {
            const stats = parseSessionFile(file);
            if (stats) {
              aggregated.mcpCalls.total += stats.mcpCalls.total;
              aggregated.mcpCalls.success += stats.mcpCalls.success;
              aggregated.mcpCalls.error += stats.mcpCalls.error;
              aggregated.toolCalls.total += stats.toolCalls.total;
              aggregated.toolCalls.success += stats.toolCalls.success;
              aggregated.toolCalls.error += stats.toolCalls.error;
              aggregated.errors.push(...stats.errors);
            }
          }

          // If filesystem data is empty (all zeros), try Express server as fallback
          const hasData =
            aggregated.mcpCalls.total > 0 ||
            aggregated.toolCalls.total > 0 ||
            aggregated.errors.length > 0;

          if (hasData) {
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(
                    {
                      source: "filesystem",
                      filesFound: sessionFiles.length,
                      ...aggregated,
                    },
                    null,
                    2,
                  ),
                },
              ],
            };
          }
        }

        // Filesystem files found but empty, or no files — try Express server as fallback
        const dashboardUrl = process.env["DASHBOARD_URL"] ?? DEFAULT_DASHBOARD_URL;

        try {
          const statsResponse = await fetch(`${dashboardUrl}/api/stats`, {
            headers: { "Content-Type": "application/json" },
          });

          if (statsResponse.ok) {
            const serverStats = (await statsResponse.json()) as {
              mcpCalls: McpCallCounts;
              toolCalls: ToolCallCounts;
              totalErrors: number;
              totalCalls: number;
              errorRate: number;
              lastUpdated: string | null;
            };

            aggregated.mcpCalls = serverStats.mcpCalls;
            aggregated.toolCalls = serverStats.toolCalls;

            // Also fetch errors for completeness
            const errorsResponse = await fetch(`${dashboardUrl}/api/errors`, {
              headers: { "Content-Type": "application/json" },
            });

            if (errorsResponse.ok) {
              const serverErrors = (await errorsResponse.json()) as Array<ErrorRecord>;
              aggregated.errors = serverErrors;
            }

            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(
                    {
                      source: "express_server",
                      message: "No session files found locally; fetched real-time stats from Express server.",
                      ...aggregated,
                    },
                    null,
                    2,
                  ),
                },
              ],
            };
          }
        } catch {
          // Express server unreachable — fall through to empty result
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  source: "none",
                  message:
                    "No session files found in OpenCode data directories and Express server unreachable. " +
                    "Please provide session data via the sessionData parameter.",
                  ...aggregated,
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      // Use provided session data
      if (parsed.sessionData) {
        for (const session of parsed.sessionData) {
          if (session.mcpCalls) {
            aggregated.mcpCalls.total += session.mcpCalls.total ?? 0;
            aggregated.mcpCalls.success += session.mcpCalls.success ?? 0;
            aggregated.mcpCalls.error += session.mcpCalls.error ?? 0;
          }
          if (session.toolCalls) {
            aggregated.toolCalls.total += session.toolCalls.total ?? 0;
            aggregated.toolCalls.success += session.toolCalls.success ?? 0;
            aggregated.toolCalls.error += session.toolCalls.error ?? 0;
          }
          if (session.errors) {
            for (const err of session.errors) {
              aggregated.errors.push({
                sessionId: session.sessionId ?? "unknown",
                mcpServer: err.mcpServer ?? "unknown",
                toolName: err.toolName ?? "unknown",
                errorMessage: err.errorMessage ?? "No error message",
                errorType: err.errorType ?? classifyError(err.errorMessage ?? ""),
                llmAnalysis: "",
                timestamp: err.timestamp ?? new Date().toISOString(),
              });
            }
          }
        }
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                source: "provided_data",
                sessionsProcessed: parsed.sessionData?.length ?? 0,
                ...aggregated,
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
      const serverUrl = parsed.serverUrl ?? process.env["DASHBOARD_URL"] ?? DEFAULT_DASHBOARD_URL;

      const payload: UploadPayload = {
        sessionId: `scan-${Date.now()}`,
        timestamp: new Date().toISOString(),
        mcpCalls: parsed.stats.mcpCalls,
        toolCalls: parsed.stats.toolCalls,
        errors: parsed.errors.map((e) => ({
          sessionId: e.sessionId ?? "unknown",
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
      const serverUrl = parsed.serverUrl ?? process.env["DASHBOARD_URL"] ?? DEFAULT_DASHBOARD_URL;

      // Step 1: Collect stats
      const aggregated: SessionStats = {
        mcpCalls: { total: 0, success: 0, error: 0 },
        toolCalls: { total: 0, success: 0, error: 0 },
        errors: [],
      };

      let source = "none";

      if (parsed.sessionData && parsed.sessionData.length > 0) {
        source = "provided_data";
        for (const session of parsed.sessionData) {
          if (session.mcpCalls) {
            aggregated.mcpCalls.total += session.mcpCalls.total ?? 0;
            aggregated.mcpCalls.success += session.mcpCalls.success ?? 0;
            aggregated.mcpCalls.error += session.mcpCalls.error ?? 0;
          }
          if (session.toolCalls) {
            aggregated.toolCalls.total += session.toolCalls.total ?? 0;
            aggregated.toolCalls.success += session.toolCalls.success ?? 0;
            aggregated.toolCalls.error += session.toolCalls.error ?? 0;
          }
          if (session.errors) {
            for (const err of session.errors) {
              aggregated.errors.push({
                sessionId: session.sessionId ?? "unknown",
                mcpServer: err.mcpServer ?? "unknown",
                toolName: err.toolName ?? "unknown",
                errorMessage: err.errorMessage ?? "No error message",
                errorType: err.errorType ?? classifyError(err.errorMessage ?? ""),
                llmAnalysis: "",
                timestamp: err.timestamp ?? new Date().toISOString(),
              });
            }
          }
        }
      } else {
        const sessionFiles = findSessionFiles();
        if (sessionFiles.length > 0) {
          source = "filesystem";
          for (const file of sessionFiles) {
            const stats = parseSessionFile(file);
            if (stats) {
              aggregated.mcpCalls.total += stats.mcpCalls.total;
              aggregated.mcpCalls.success += stats.mcpCalls.success;
              aggregated.mcpCalls.error += stats.mcpCalls.error;
              aggregated.toolCalls.total += stats.toolCalls.total;
              aggregated.toolCalls.success += stats.toolCalls.success;
              aggregated.toolCalls.error += stats.toolCalls.error;
              aggregated.errors.push(...stats.errors);
            }
          }
        }
      }

      // Step 2: Analyze each error
      const analyzedErrors: ErrorRecord[] = [];
      for (const err of aggregated.errors) {
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

      // Step 3: Upload
      const payload: UploadPayload = {
        sessionId: `full-scan-${Date.now()}`,
        timestamp: new Date().toISOString(),
        mcpCalls: aggregated.mcpCalls,
        toolCalls: aggregated.toolCalls,
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
                stats: {
                  mcpCalls: aggregated.mcpCalls,
                  toolCalls: aggregated.toolCalls,
                },
                errors: analyzedErrors,
                uploaded,
                uploadMessage,
                source,
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
      const serverUrl = parsed.serverUrl ?? process.env["DASHBOARD_URL"] ?? DEFAULT_DASHBOARD_URL;

      try {
        const callsResponse = await fetch(`${serverUrl}/api/calls`, {
          headers: { "Content-Type": "application/json" },
        });

        if (!callsResponse.ok) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    success: false,
                    message: `Failed to fetch calls from server: ${callsResponse.status} ${await callsResponse.text()}`,
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        }

        const callsData = (await callsResponse.json()) as {
          calls: Array<Record<string, unknown>>;
          lastUpdated: string | null;
        };

        const now = Date.now();
        const cutoff = now - hours * 60 * 60 * 1000;

        const filteredCalls = callsData.calls.filter((call) => {
          const ts = call["timestamp"] as string | undefined;
          if (!ts) return false;
          return new Date(ts).getTime() >= cutoff;
        });

        // Group calls into time buckets
        const bucketMap = new Map<string, Array<Record<string, unknown>>>();

        for (const call of filteredCalls) {
          const ts = call["timestamp"] as string | undefined;
          if (!ts) continue;
          const date = new Date(ts);

          let bucketLabel: string;
          if (groupBy === "day") {
            bucketLabel = date.toISOString().slice(0, 10);
          } else {
            bucketLabel = date.toISOString().slice(0, 13);
          }

          const existing = bucketMap.get(bucketLabel);
          if (existing) {
            existing.push(call);
          } else {
            bucketMap.set(bucketLabel, [call]);
          }
        }

        // Compute per-bucket metrics
        const trends: Array<{
          timeBucket: string;
          totalCalls: number;
          mcpCalls: number;
          toolCalls: number;
          successCount: number;
          errorCount: number;
          errorRate: number;
          topErrors: Array<{ errorType: string; count: number }>;
          topFailingTools: Array<{ toolName: string; count: number }>;
        }> = [];

        for (const [bucketLabel, bucketCalls] of bucketMap) {
          let mcpCalls = 0;
          let toolCalls = 0;
          let successCount = 0;
          let errorCount = 0;

          const errorTypeCounts = new Map<string, number>();
          const toolErrorCounts = new Map<string, number>();

          for (const call of bucketCalls) {
            const isMcp = (call["isMcpCall"] as boolean | undefined) ?? false;
            const success = (call["success"] as boolean | undefined) ?? true;

            if (isMcp) {
              mcpCalls++;
            } else {
              toolCalls++;
            }

            if (success) {
              successCount++;
            } else {
              errorCount++;

              const errMsg = (call["errorMessage"] as string | undefined) ?? "";
              const errType = (call["errorType"] as string | undefined) ?? classifyError(errMsg);
              errorTypeCounts.set(errType, (errorTypeCounts.get(errType) ?? 0) + 1);

              const toolName = (call["tool"] as string | undefined) ?? (call["toolName"] as string | undefined) ?? "unknown";
              toolErrorCounts.set(toolName, (toolErrorCounts.get(toolName) ?? 0) + 1);
            }
          }

          const totalCalls = bucketCalls.length;
          const errorRate = totalCalls > 0 ? (errorCount / totalCalls) * 100 : 0;

          const topErrors = [...errorTypeCounts.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 3)
            .map(([errorType, count]) => ({ errorType, count }));

          const topFailingTools = [...toolErrorCounts.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 3)
            .map(([toolName, count]) => ({ toolName, count }));

          trends.push({
            timeBucket: bucketLabel,
            totalCalls,
            mcpCalls,
            toolCalls,
            successCount,
            errorCount,
            errorRate,
            topErrors,
            topFailingTools,
          });
        }

        // Sort trends by timeBucket ascending
        trends.sort((a, b) => a.timeBucket.localeCompare(b.timeBucket));

        // Compute overall summary
        const totalCalls = filteredCalls.length;
        const totalErrors = trends.reduce((sum, b) => sum + b.errorCount, 0);
        const overallErrorRate = totalCalls > 0 ? (totalErrors / totalCalls) * 100 : 0;
        const totalMcpCalls = trends.reduce((sum, b) => sum + b.mcpCalls, 0);
        const mcpCallRatio = totalCalls > 0 ? (totalMcpCalls / totalCalls) * 100 : 0;

        let peakHour = "";
        let peakHourCalls = 0;
        let peakErrorHour = "";
        let peakErrorHourErrors = 0;

        for (const bucket of trends) {
          if (bucket.totalCalls > peakHourCalls) {
            peakHourCalls = bucket.totalCalls;
            peakHour = bucket.timeBucket;
          }
          if (bucket.errorCount > peakErrorHourErrors) {
            peakErrorHourErrors = bucket.errorCount;
            peakErrorHour = bucket.timeBucket;
          }
        }

        const bucketCount = trends.length;
        const averageCallsPerHour = bucketCount > 0 ? totalCalls / (groupBy === "day" ? hours / 24 : hours) : 0;

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  trends,
                  summary: {
                    totalCalls,
                    overallErrorRate,
                    mcpCallRatio,
                    peakHour,
                    peakErrorHour,
                    averageCallsPerHour,
                  },
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
                  message: `Failed to fetch trend data: ${errorMessage}`,
                },
                null,
                2,
              ),
            },
          ],
        };
      }
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
