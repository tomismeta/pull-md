import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema
} from '@modelcontextprotocol/sdk/types.js';

import { isAppError } from './errors.js';
import {
  MCP_PROTOCOL_VERSION,
  getMcpToolsListResult,
  invokeToolRegistry
} from './mcp_tools.js';
import {
  getMcpPromptsList,
  getMcpPrompt,
  getMcpResourcesList,
  readMcpResource
} from './mcp_contract.js';
import { recordTelemetryEvent } from './telemetry.js';

const SERVER_INFO = {
  name: 'PULL.md',
  version: '1.0.0'
};

const SERVER_INSTRUCTIONS =
  'Use tools/list + tools/call for orchestration. Call get_auth_challenge before authenticated creator/moderator/session/redownload flows. For x402 payment, use GET /api/assets/{id}/download (legacy alias: /api/souls/{id}/download). Persist X-PURCHASE-RECEIPT securely for no-repay re-downloads; do not log or share receipt values.';

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

function walletFromToolArgs(args) {
  const parsed = args && typeof args === 'object' ? args : {};
  const wallet = parsed.wallet_address || parsed.moderator_address || parsed.wallet;
  return typeof wallet === 'string' ? wallet : null;
}

function assetIdFromToolArgs(args) {
  const parsed = args && typeof args === 'object' ? args : {};
  const value = parsed.asset_id || parsed.soul_id || parsed.id;
  return typeof value === 'string' ? value : null;
}

function getHeadersFromExtra(extra, fallbackHeaders) {
  const requestHeaders = extra?.requestInfo?.headers;
  if (requestHeaders && typeof requestHeaders === 'object') return requestHeaders;
  return fallbackHeaders || {};
}

function buildMcpSdkServer({ requestHeaders } = {}) {
  const server = new Server(SERVER_INFO, {
    capabilities: {
      tools: {},
      prompts: {},
      resources: {}
    },
    instructions: SERVER_INSTRUCTIONS
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: getMcpToolsListResult()
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const name = String(request?.params?.name || '').trim();
    if (!name) {
      throw new McpError(ErrorCode.InvalidParams, 'Missing required params.name');
    }

    const args =
      request?.params?.arguments && typeof request.params.arguments === 'object'
        ? request.params.arguments
        : {};
    const start = Date.now();

    try {
      const output = await invokeToolRegistry(name, args, {
        headers: getHeadersFromExtra(extra, requestHeaders)
      });
      void recordTelemetryEvent({
        eventType: 'mcp.tool_invocation',
        source: 'mcp',
        route: '/mcp',
        httpMethod: 'POST',
        rpcMethod: 'tools/call',
        toolName: name,
        action: name,
        walletAddress: walletFromToolArgs(args),
        assetId: assetIdFromToolArgs(args),
        success: true,
        statusCode: 200,
        metadata: {
          duration_ms: Date.now() - start,
          argument_keys: Object.keys(args || {}).slice(0, 24)
        }
      });
      return {
        content: [
          {
            type: 'text',
            text: `Tool ${name} executed successfully.`
          }
        ],
        structuredContent: output
      };
    } catch (error) {
      if (isAppError(error)) {
        const normalized = normalizeToolError(error);
        void recordTelemetryEvent({
          eventType: 'mcp.tool_invocation',
          source: 'mcp',
          route: '/mcp',
          httpMethod: 'POST',
          rpcMethod: 'tools/call',
          toolName: name,
          action: name,
          walletAddress: walletFromToolArgs(args),
          assetId: assetIdFromToolArgs(args),
          success: false,
          statusCode: Number(error.status || 500),
          errorCode: normalized.code || null,
          errorMessage: normalized.message || null,
          metadata: {
            duration_ms: Date.now() - start,
            retryable: normalized.retryable === true
          }
        });
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: normalized.hint ? `${normalized.message} Hint: ${normalized.hint}` : normalized.message
            }
          ],
          structuredContent: normalized
        };
      }
      void recordTelemetryEvent({
        eventType: 'mcp.tool_invocation',
        source: 'mcp',
        route: '/mcp',
        httpMethod: 'POST',
        rpcMethod: 'tools/call',
        toolName: name,
        action: name,
        walletAddress: walletFromToolArgs(args),
        assetId: assetIdFromToolArgs(args),
        success: false,
        statusCode: 500,
        errorCode: 'mcp_internal_error',
        errorMessage: error instanceof Error ? error.message : String(error || 'Internal error'),
        metadata: {
          duration_ms: Date.now() - start
        }
      });
      throw new McpError(
        ErrorCode.InternalError,
        error instanceof Error ? error.message : String(error || 'Internal error')
      );
    }
  });

  server.setRequestHandler(ListPromptsRequestSchema, async () => {
    return {
      prompts: getMcpPromptsList()
    };
  });

  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const name = String(request?.params?.name || '').trim();
    if (!name) {
      throw new McpError(ErrorCode.InvalidParams, 'Missing required params.name');
    }
    const args =
      request?.params?.arguments && typeof request.params.arguments === 'object'
        ? request.params.arguments
        : {};

    try {
      return getMcpPrompt(name, args);
    } catch (error) {
      if (isAppError(error)) {
        const normalized = normalizeToolError(error);
        return {
          isError: true,
          content: [{ type: 'text', text: normalized.message }],
          structuredContent: normalized
        };
      }
      throw new McpError(
        ErrorCode.InternalError,
        error instanceof Error ? error.message : String(error || 'Internal error')
      );
    }
  });

  server.setRequestHandler(ListResourcesRequestSchema, async (_request, extra) => {
    try {
      const resources = await getMcpResourcesList({
        headers: getHeadersFromExtra(extra, requestHeaders)
      });
      return { resources };
    } catch (error) {
      if (isAppError(error)) {
        const normalized = normalizeToolError(error);
        return {
          isError: true,
          content: [{ type: 'text', text: normalized.message }],
          structuredContent: normalized
        };
      }
      throw new McpError(
        ErrorCode.InternalError,
        error instanceof Error ? error.message : String(error || 'Internal error')
      );
    }
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (request, extra) => {
    const uri = String(request?.params?.uri || '').trim();
    if (!uri) {
      throw new McpError(ErrorCode.InvalidParams, 'Missing required params.uri');
    }
    try {
      const content = await readMcpResource(uri, {
        headers: getHeadersFromExtra(extra, requestHeaders)
      });
      return { contents: [content] };
    } catch (error) {
      if (isAppError(error)) {
        const normalized = normalizeToolError(error);
        return {
          isError: true,
          content: [{ type: 'text', text: normalized.message }],
          structuredContent: normalized
        };
      }
      throw new McpError(
        ErrorCode.InternalError,
        error instanceof Error ? error.message : String(error || 'Internal error')
      );
    }
  });

  return server;
}

export function getMcpServerMetadata() {
  return {
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
    protocolVersion: MCP_PROTOCOL_VERSION,
    note: 'Use POST with JSON-RPC 2.0 payloads.'
  };
}

export async function handleMcpRequestWithSdk(req, res) {
  // Backward-compatibility shim:
  // existing SoulStarter clients send `Accept: application/json`.
  // Streamable HTTP expects clients to accept both JSON and SSE.
  const currentAccept = String(req?.headers?.accept || '').toLowerCase();
  if (!currentAccept.includes('text/event-stream')) {
    const merged = [String(req?.headers?.accept || '').trim(), 'application/json', 'text/event-stream']
      .filter(Boolean)
      .join(', ');
    req.headers.accept = merged;
  }

  const server = buildMcpSdkServer({ requestHeaders: req?.headers || {} });
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req?.body);
  } finally {
    try {
      await transport.close();
    } catch (_) {
      // best-effort close for stateless transport
    }
    try {
      await server.close();
    } catch (_) {
      // best-effort close for stateless server instance
    }
  }
}
