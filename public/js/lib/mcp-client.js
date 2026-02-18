(function attachSoulStarterMcpClient(globalScope) {
  if (!globalScope || typeof globalScope !== 'object') return;

  let rpcSequence = 0;

  function nextRpcId(prefix) {
    rpcSequence += 1;
    return `${prefix}-${Date.now()}-${rpcSequence}`;
  }

  function extractErrorMessage(payload, fallback) {
    const detail = payload && typeof payload === 'object' ? payload.error : null;
    if (detail && typeof detail === 'object' && typeof detail.message === 'string' && detail.message.trim()) {
      return detail.message.trim();
    }
    if (typeof payload?.message === 'string' && payload.message.trim()) {
      return payload.message.trim();
    }
    return fallback;
  }

  async function mcpRpcCall(method, params, options = {}) {
    const endpoint = String(options.endpoint || '/mcp');
    const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(1, Number(options.timeoutMs)) : 45000;
    const idPrefix = String(options.idPrefix || 'mcp');

    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream'
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: nextRpcId(idPrefix),
          method: String(method || '').trim(),
          params: params && typeof params === 'object' ? params : {}
        }),
        signal: controller.signal
      });
      const payload = await response.json().catch(() => null);

      if (!response.ok) {
        throw new Error(extractErrorMessage(payload, `MCP request failed (${response.status})`));
      }
      if (!payload || payload.jsonrpc !== '2.0') {
        throw new Error('Invalid MCP response');
      }
      if (payload.error) {
        throw new Error(extractErrorMessage(payload, 'MCP request failed'));
      }

      return payload.result || {};
    } catch (error) {
      if (error && error.name === 'AbortError') {
        throw new Error('MCP request timed out');
      }
      throw error;
    } finally {
      clearTimeout(timeoutHandle);
    }
  }

  async function mcpToolCall(name, args, options = {}) {
    const toolName = String(name || '').trim();
    if (!toolName) throw new Error('Missing MCP tool name');

    const result = await mcpRpcCall(
      'tools/call',
      {
        name: toolName,
        arguments: args && typeof args === 'object' ? args : {}
      },
      options
    );

    if (result && result.isError) {
      const structured = result.structuredContent;
      const contentMessage = Array.isArray(result.content) ? result.content[0]?.text : '';
      const detail =
        (structured && typeof structured.error === 'string' && structured.error) ||
        (typeof contentMessage === 'string' && contentMessage) ||
        'MCP tool error';
      const toolError = new Error(detail);
      if (structured && typeof structured === 'object') {
        Object.assign(toolError, structured);
      }
      throw toolError;
    }

    return result?.structuredContent || {};
  }

  globalScope.SoulStarterMcp = {
    rpc: mcpRpcCall,
    callTool: mcpToolCall
  };
})(typeof window !== 'undefined' ? window : globalThis);
