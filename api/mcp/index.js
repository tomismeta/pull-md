import { isAppError } from '../_lib/errors.js';
import { setCors } from '../_lib/payments.js';
import {
  MCP_PROTOCOL_VERSION,
  getMcpToolsListResult,
  invokeMcpTool
} from '../_lib/mcp_tools.js';
import {
  getMcpPromptsList,
  getMcpPrompt,
  getMcpResourcesList,
  readMcpResource
} from '../_lib/mcp_contract.js';

const SERVER_INFO = {
  name: 'SoulStarter',
  version: '1.0.0'
};

function asJsonRpcError(code, message, data = null) {
  return {
    code,
    message,
    ...(data == null ? {} : { data })
  };
}

function sendJsonRpcError(res, id, code, message, data = null, status = 200) {
  return res.status(status).json({
    jsonrpc: '2.0',
    id: id ?? null,
    error: asJsonRpcError(code, message, data)
  });
}

function sendJsonRpcResult(res, id, result) {
  return res.status(200).json({
    jsonrpc: '2.0',
    id: id ?? null,
    result
  });
}

function normalizeToolError(error) {
  const payload = error?.payload && typeof error.payload === 'object' ? error.payload : {};
  const message = String(payload.error || payload.message || error?.message || 'Tool execution failed');
  const code = String(payload.code || 'tool_execution_error');
  const hint = payload.flow_hint || payload.hint || null;
  const retryable =
    typeof payload.retryable === 'boolean' ? payload.retryable : Number(error?.status || 500) >= 500;
  return {
    ...payload,
    ok: false,
    code,
    message,
    hint,
    retryable
  };
}

function parseJsonRpcBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string' && req.body.trim()) {
    return JSON.parse(req.body);
  }
  return null;
}

export default async function handler(req, res) {
  setCors(res, req.headers.origin);
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method === 'GET') {
    return res.status(200).json({
      name: SERVER_INFO.name,
      protocol: 'mcp',
      transport: 'streamable_http',
      response_streaming: false,
      sampling: 'not_supported',
      endpoint: '/mcp',
      methods: [
        'initialize',
        'notifications/initialized',
        'ping',
        'tools/list',
        'tools/call',
        'prompts/list',
        'prompts/get',
        'resources/list',
        'resources/read'
      ],
      note: 'Use POST with JSON-RPC 2.0 payloads.'
    });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  let rpc;
  try {
    rpc = parseJsonRpcBody(req);
  } catch (error) {
    return sendJsonRpcError(res, null, -32700, 'Parse error', {
      detail: error instanceof Error ? error.message : String(error || 'invalid_json')
    });
  }

  if (!rpc || typeof rpc !== 'object' || Array.isArray(rpc)) {
    return sendJsonRpcError(res, null, -32600, 'Invalid Request');
  }

  const id = rpc.id;
  const method = String(rpc.method || '').trim();
  const params = rpc.params && typeof rpc.params === 'object' ? rpc.params : {};

  if (!method || rpc.jsonrpc !== '2.0') {
    return sendJsonRpcError(res, id ?? null, -32600, 'Invalid Request');
  }

  if (method === 'notifications/initialized') {
    if (id === undefined) return res.status(202).end();
    return sendJsonRpcResult(res, id, {});
  }

  if (method === 'initialize') {
    return sendJsonRpcResult(res, id, {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {
        tools: {},
        prompts: {},
        resources: {}
      },
      serverInfo: SERVER_INFO,
      instructions:
        'Use tools/list + tools/call for orchestration. Call get_auth_challenge before authenticated creator/moderator/session/redownload flows. For x402 payment, use GET /api/souls/{id}/download.'
    });
  }

  if (method === 'ping') {
    return sendJsonRpcResult(res, id, {});
  }

  if (method === 'tools/list') {
    return sendJsonRpcResult(res, id, {
      tools: getMcpToolsListResult()
    });
  }

  if (method === 'tools/call') {
    const name = String(params.name || '').trim();
    const args = params.arguments && typeof params.arguments === 'object' ? params.arguments : {};
    if (!name) {
      return sendJsonRpcError(res, id, -32602, 'Invalid params', {
        detail: 'Missing required params.name'
      });
    }
    try {
      const output = await invokeMcpTool(name, args, { headers: req.headers });
      return sendJsonRpcResult(res, id, {
        content: [
          {
            type: 'text',
            text: `Tool ${name} executed successfully.`
          }
        ],
        structuredContent: output
      });
    } catch (error) {
      if (isAppError(error)) {
        const normalized = normalizeToolError(error);
        return sendJsonRpcResult(res, id, {
          isError: true,
          content: [
            {
              type: 'text',
              text: normalized.hint ? `${normalized.message} Hint: ${normalized.hint}` : normalized.message
            }
          ],
          structuredContent: normalized
        });
      }
      return sendJsonRpcError(res, id, -32603, 'Internal error', {
        detail: error instanceof Error ? error.message : String(error || 'unknown_error')
      });
    }
  }

  if (method === 'prompts/list') {
    return sendJsonRpcResult(res, id, {
      prompts: getMcpPromptsList()
    });
  }

  if (method === 'prompts/get') {
    const name = String(params.name || '').trim();
    const args = params.arguments && typeof params.arguments === 'object' ? params.arguments : {};
    if (!name) {
      return sendJsonRpcError(res, id, -32602, 'Invalid params', {
        detail: 'Missing required params.name'
      });
    }
    try {
      const prompt = getMcpPrompt(name, args);
      return sendJsonRpcResult(res, id, prompt);
    } catch (error) {
      if (isAppError(error)) {
        const normalized = normalizeToolError(error);
        return sendJsonRpcResult(res, id, {
          isError: true,
          content: [{ type: 'text', text: normalized.message }],
          structuredContent: normalized
        });
      }
      return sendJsonRpcError(res, id, -32603, 'Internal error', {
        detail: error instanceof Error ? error.message : String(error || 'unknown_error')
      });
    }
  }

  if (method === 'resources/list') {
    try {
      const resources = await getMcpResourcesList({ headers: req.headers });
      return sendJsonRpcResult(res, id, { resources });
    } catch (error) {
      if (isAppError(error)) {
        const normalized = normalizeToolError(error);
        return sendJsonRpcResult(res, id, {
          isError: true,
          content: [{ type: 'text', text: normalized.message }],
          structuredContent: normalized
        });
      }
      return sendJsonRpcError(res, id, -32603, 'Internal error', {
        detail: error instanceof Error ? error.message : String(error || 'unknown_error')
      });
    }
  }

  if (method === 'resources/read') {
    const uri = String(params.uri || '').trim();
    if (!uri) {
      return sendJsonRpcError(res, id, -32602, 'Invalid params', {
        detail: 'Missing required params.uri'
      });
    }
    try {
      const content = await readMcpResource(uri, { headers: req.headers });
      return sendJsonRpcResult(res, id, { contents: [content] });
    } catch (error) {
      if (isAppError(error)) {
        const normalized = normalizeToolError(error);
        return sendJsonRpcResult(res, id, {
          isError: true,
          content: [{ type: 'text', text: normalized.message }],
          structuredContent: normalized
        });
      }
      return sendJsonRpcError(res, id, -32603, 'Internal error', {
        detail: error instanceof Error ? error.message : String(error || 'unknown_error')
      });
    }
  }

  return sendJsonRpcError(res, id ?? null, -32601, 'Method not found', { method });
}
