import { isAppError } from '../_lib/errors.js';
import { setCors } from '../_lib/payments.js';
import { buildPublicAssetsResponse, listAssetsCatalog } from '../_lib/services/souls.js';
import { recordTelemetryEvent } from '../_lib/telemetry.js';

export default async function handler(req, res) {
  setCors(res, req.headers.origin);

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const assets = await listAssetsCatalog({
      category: req.query?.category,
      assetType: req.query?.asset_type
    });
    void recordTelemetryEvent({
      eventType: 'catalog.list_assets',
      source: 'api',
      route: '/api/assets',
      httpMethod: 'GET',
      success: true,
      statusCode: 200,
      metadata: {
        category: req.query?.category || null,
        asset_type: req.query?.asset_type || null,
        count: assets.length
      }
    });
    return res.status(200).json(buildPublicAssetsResponse(assets));
  } catch (error) {
    if (isAppError(error)) {
      void recordTelemetryEvent({
        eventType: 'catalog.list_assets',
        source: 'api',
        route: '/api/assets',
        httpMethod: 'GET',
        success: false,
        statusCode: Number(error.status || 500),
        errorCode: String(error.payload?.code || '').trim() || null,
        errorMessage: String(error.payload?.error || error.message || 'Unable to load asset catalog'),
        metadata: {
          category: req.query?.category || null,
          asset_type: req.query?.asset_type || null
        }
      });
      return res.status(error.status).json(error.payload);
    }
    void recordTelemetryEvent({
      eventType: 'catalog.list_assets',
      source: 'api',
      route: '/api/assets',
      httpMethod: 'GET',
      success: false,
      statusCode: 500,
      errorCode: 'catalog_internal_error',
      errorMessage: error?.message || 'unknown_error',
      metadata: {
        category: req.query?.category || null,
        asset_type: req.query?.asset_type || null
      }
    });
    return res.status(500).json({
      error: 'Unable to load asset catalog',
      details: error?.message || 'unknown_error'
    });
  }
}
