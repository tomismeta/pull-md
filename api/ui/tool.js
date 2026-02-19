import { invokeMcpTool } from '../_lib/mcp_tools.js';
import { isAppError } from '../_lib/errors.js';
import { setCors } from '../_lib/payments.js';

function parseBody(req) {
  const payload = req?.body;
  if (!payload) return {};
  if (typeof payload === 'string') {
    try {
      return JSON.parse(payload);
    } catch (_) {
      return {};
    }
  }
  return payload && typeof payload === 'object' ? payload : {};
}

export default async function handler(req, res) {
  setCors(res, req.headers.origin);

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const body = parseBody(req);
  const name = String(body?.name || '').trim();
  const args = body?.arguments && typeof body.arguments === 'object' ? body.arguments : {};

  if (!name) {
    return res.status(400).json({ error: 'Missing required field: name' });
  }

  try {
    const result = await invokeMcpTool(name, args, {
      headers: req.headers || {},
      source: 'ui_rest',
      route: '/api/ui/tool',
      httpMethod: 'POST'
    });
    return res.status(200).json(result || {});
  } catch (error) {
    if (isAppError(error)) {
      return res.status(error.status).json(error.payload);
    }
    return res.status(500).json({
      error: error?.message || 'UI tool execution failed',
      code: 'ui_tool_execution_failed',
      tool_name: name
    });
  }
}
