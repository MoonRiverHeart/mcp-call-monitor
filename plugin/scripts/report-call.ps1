# mcp-call-monitor PostToolUse hook script
# Receives JSON via stdin, POSTs call data to Express server at localhost:3210

$ErrorActionPreference = 'SilentlyContinue'

try {
    $stdin = [Console]::In.ReadToEnd()
    if (-not $stdin) { exit 0 }

    $data = $stdin | ConvertFrom-Json
    if (-not $data) { exit 0 }

    # Null-safe property access (PS5 compat: use if/else instead of ??)
    $toolName = if ($data.tool_name) { $data.tool_name } else { '' }
    $sessionId = if ($data.session_id) { $data.session_id } else { '' }
    $callId = if ($data.call_id) { $data.call_id } else { '' }
    $toolInput = if ($data.tool_input) { $data.tool_input } else { @{} }
    $toolOutput = if ($data.tool_output) { $data.tool_output } else { '' }

    # Determine if MCP call (tool name contains underscore and not builtin)
    $builtinTools = @('bash','read','edit','write','glob','grep','webfetch','todowrite','question','look_at','session','skill','task')
    $isMcp = $toolName.Contains('_') -and ($builtinTools -notcontains $toolName)

    # Parse MCP server/tool name
    $mcpServer = $null
    $mcpToolName = $null
    if ($isMcp) {
        $idx = $toolName.IndexOf('_')
        $mcpServer = $toolName.Substring(0, $idx)
        $mcpToolName = $toolName.Substring($idx + 1)
    }

    # Determine success/error from output
    $success = $true
    $errorMessage = $null
    $errorType = $null
    $outputText = ''
    $titleText = ''
    if ($toolOutput -is [string]) {
        $outputText = $toolOutput
    } elseif ($toolOutput.output) {
        $outputText = $toolOutput.output
        if ($toolOutput.title) { $titleText = $toolOutput.title }
    }

    $combined = "$titleText $outputText"
    $errorIndicators = @('MCP error','Error:','error -32603','error:','failed','ETIMEDOUT','ECONNREFUSED')
    foreach ($ind in $errorIndicators) {
        if ($combined.Contains($ind)) {
            $success = $false
            break
        }
    }

    if (-not $success) {
        if ($combined.Length -gt 500) { $errorMessage = $combined.Substring(0, 500) } else { $errorMessage = $combined }
        if ($errorMessage -match 'timeout|timed out|ETIMEDOUT') { $errorType = 'timeout' }
        elseif ($errorMessage -match 'permission|access denied|EACCES') { $errorType = 'permission_denied' }
        elseif ($errorMessage -match 'network|ECONNREFUSED|ENOTFOUND|fetch failed') { $errorType = 'network_error' }
        elseif ($errorMessage -match 'invalid|parse|format|schema|VALIDATION') { $errorType = 'invalid_response' }
        elseif ($errorMessage -match 'auth|cookie|token|credential|expired|COOKIE_EXPIRED') { $errorType = 'auth_expired' }
        else { $errorType = 'unknown' }
    }

    # Build args summary
    $argsJson = $toolInput | ConvertTo-Json -Compress
    if ($argsJson.Length -gt 500) { $argsJson = $argsJson.Substring(0, 500) }
    if ($outputText.Length -gt 200) { $outputText = $outputText.Substring(0, 200) }

    # Build payload
    $ts = (Get-Date).ToUniversalTime().ToString('o')
    $body = '{"sessionId":"' + $sessionId + '","callId":"' + $callId + '","timestamp":"' + $ts + '","tool":"' + $toolName + '","isMcpCall":' + $isMcp.ToString().ToLower() + ','
    if ($mcpServer) { $body += '"mcpServer":"' + $mcpServer + '","mcpToolName":"' + $mcpToolName + '",' }
    $body += '"success":' + $success.ToString().ToLower() + ','
    if ($errorMessage) { $body += '"errorMessage":"' + $errorMessage.Replace('"','\"') + '","errorType":"' + $errorType + '",' }
    $body += '"argsSummary":"' + $argsJson.Replace('"','\"') + '","outputSummary":"' + $outputText.Replace('"','\"') + '"}'

    # Fire-and-forget POST
    Invoke-RestMethod -Uri 'http://localhost:3210/api/call' -Method Post -ContentType 'application/json' -Body $body -TimeoutSec 5
} catch {
    # Silently fail
}

exit 0
