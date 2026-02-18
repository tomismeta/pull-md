import { setCors } from '../_lib/payments.js';
import { getMcpServerMetadata, handleMcpRequestWithSdk } from '../_lib/mcp_sdk.js';
import { recordTelemetryEvent } from '../_lib/telemetry.js';

function sendJsonRpcInternalError(res, message = 'Internal error') {
  res.status(500).json({
    jsonrpc: '2.0',
    id: null,
    error: {
      code: -32603,
      message
    }
  });
}

export default async function handler(req, res) {
  setCors(res, req.headers.origin);

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method === 'GET') {
    void recordTelemetryEvent({
      eventType: 'mcp.transport_request',
      source: 'mcp',
      route: '/mcp',
      httpMethod: 'GET',
      rpcMethod: 'metadata',
      success: true,
      statusCode: 200
    });
    return res.status(200).json(getMcpServerMetadata());
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const start = Date.now();
  const rpcMethod = String(req?.body?.method || '').trim() || null;
  try {
    await handleMcpRequestWithSdk(req, res);
    void recordTelemetryEvent({
      eventType: 'mcp.transport_request',
      source: 'mcp',
      route: '/mcp',
      httpMethod: 'POST',
      rpcMethod,
      success: Number(res.statusCode || 200) < 400,
      statusCode: Number(res.statusCode || 200),
      metadata: {
        duration_ms: Date.now() - start
      }
    });
  } catch (error) {
    void recordTelemetryEvent({
      eventType: 'mcp.transport_error',
      source: 'mcp',
      route: '/mcp',
      httpMethod: 'POST',
      rpcMethod,
      success: false,
      statusCode: 500,
      errorCode: 'mcp_transport_exception',
      errorMessage: error instanceof Error ? error.message : String(error || 'Internal error'),
      metadata: {
        duration_ms: Date.now() - start
      }
    });
    if (!res.headersSent) {
      return sendJsonRpcInternalError(
        res,
        error instanceof Error ? error.message : String(error || 'Internal error')
      );
    }
  }
}
