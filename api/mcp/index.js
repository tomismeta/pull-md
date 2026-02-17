import { setCors } from '../_lib/payments.js';
import { getMcpServerMetadata, handleMcpRequestWithSdk } from '../_lib/mcp_sdk.js';

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
    return res.status(200).json(getMcpServerMetadata());
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    await handleMcpRequestWithSdk(req, res);
  } catch (error) {
    if (!res.headersSent) {
      return sendJsonRpcInternalError(
        res,
        error instanceof Error ? error.message : String(error || 'Internal error')
      );
    }
  }
}
