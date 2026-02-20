import { executeCreatorMarketplaceAction } from '../_lib/services/creator_marketplace.js';
import { AppError } from '../_lib/errors.js';
import { recordTelemetryEvent } from '../_lib/telemetry.js';

const ALLOWED_ACTIONS = new Set([
  'list_moderators',
  'get_telemetry_dashboard',
  'list_moderation_listings',
  'get_listing_scan_details',
  'approve_listing_scan',
  'remove_listing_visibility',
  'restore_listing_visibility',
  'update_listing',
  'delete_listing'
]);

const READ_ACTIONS = new Set(['list_moderators', 'get_telemetry_dashboard', 'list_moderation_listings', 'get_listing_scan_details']);
const WRITE_ACTIONS = new Set([
  'approve_listing_scan',
  'remove_listing_visibility',
  'restore_listing_visibility',
  'update_listing',
  'delete_listing'
]);

function setCors(res, origin) {
  const allowedOrigins = [
    'https://pullmd.vercel.app',
    'https://pullmd.io',
    'https://pull.md',
    'https://www.pull.md',
    'http://localhost:3000',
    'http://localhost:8080'
  ];
  if (allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, X-MODERATOR-ADDRESS, X-MODERATOR-SIGNATURE, X-MODERATOR-TIMESTAMP, X-REDOWNLOAD-SESSION'
  );
  res.setHeader('Content-Type', 'application/json');
}

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

function readAction(req, body) {
  const query = req?.query && typeof req.query === 'object' ? req.query : {};
  return String(query.action || body.action || '').trim();
}

function resolveMethodForAction(action, method) {
  const normalizedMethod = String(method || '').toUpperCase();
  if (READ_ACTIONS.has(action)) return 'GET';
  if (WRITE_ACTIONS.has(action)) return 'POST';
  return normalizedMethod || 'GET';
}

export default async function handler(req, res) {
  setCors(res, req.headers.origin);

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    const body = parseBody(req);
    const action = readAction(req, body);
    if (!ALLOWED_ACTIONS.has(action)) {
      throw new AppError(400, {
        error: 'Unsupported moderation action',
        action,
        supported_actions: [...ALLOWED_ACTIONS]
      });
    }

    const expectedMethod = resolveMethodForAction(action, req.method);
    if (String(req.method || '').toUpperCase() !== expectedMethod) {
      throw new AppError(405, {
        error: `Method not allowed for action=${action}`,
        required_method: expectedMethod
      });
    }

    const payload = await executeCreatorMarketplaceAction({
      action,
      method: expectedMethod,
      headers: req.headers || {},
      body: {
        ...(req.query && typeof req.query === 'object' ? req.query : {}),
        ...body
      },
      telemetryContext: {
        source: 'api',
        route: '/api/moderation',
        httpMethod: expectedMethod
      }
    });
    void recordTelemetryEvent({
      eventType: 'moderation.request',
      source: 'api',
      route: '/api/moderation',
      httpMethod: String(req.method || '').toUpperCase(),
      action,
      walletAddress: req.headers['x-moderator-address'] || body?.moderator_address || null,
      success: true,
      statusCode: 200
    });
    return res.status(200).json(payload);
  } catch (error) {
    const status =
      Number.isFinite(Number(error?.status)) ? Number(error.status) : Number.isFinite(Number(error?.statusCode)) ? Number(error.statusCode) : 500;
    const body =
      error instanceof AppError
        ? error.payload
        : {
            error: error?.message || 'Internal server error'
          };
    void recordTelemetryEvent({
      eventType: 'moderation.request',
      source: 'api',
      route: '/api/moderation',
      httpMethod: String(req.method || '').toUpperCase(),
      action: String(req?.query?.action || parseBody(req)?.action || '').trim() || null,
      walletAddress: req.headers['x-moderator-address'] || null,
      success: false,
      statusCode: status,
      errorCode: String(body?.code || '').trim() || null,
      errorMessage: String(body?.error || body?.message || 'moderation_request_failed')
    });
    return res.status(status).json(body);
  }
}
