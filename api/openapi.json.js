import { openApiContentType, resolveBaseUrl, setDiscoveryHeaders } from './_lib/discovery.js';

function buildOpenApiDocument(baseUrl) {
  return {
    openapi: '3.1.0',
    info: {
      title: 'PULL.md REST API',
      version: '1.0.0',
      summary: 'REST discovery and commerce endpoints for PULL.md',
      description:
        'REST surface for public catalog discovery and canonical x402 purchase/re-download delivery. MCP transport is exposed separately at /mcp.',
      contact: {
        name: 'PULL.md Support',
        url: `${baseUrl}/WEBMCP.md`
      }
    },
    servers: [{ url: baseUrl }],
    paths: {
      '/api/assets': {
        get: {
          operationId: 'listAssets',
          summary: 'List public assets',
          description: 'Returns the current public markdown asset catalog.',
          responses: {
            '200': {
              description: 'Catalog response',
              content: {
                'application/json': {
                  schema: { type: 'object' }
                }
              }
            }
          }
        }
      },
      '/api/assets/{id}/download': {
        get: {
          operationId: 'downloadAsset',
          summary: 'Purchase or re-download an asset',
          description:
            'Canonical x402 endpoint for purchase and receipt-first re-download. First request typically returns 402 with PAYMENT-REQUIRED.',
          parameters: [
            {
              name: 'id',
              in: 'path',
              required: true,
              schema: { type: 'string' }
            }
          ],
          responses: {
            '200': {
              description: 'Markdown content returned after purchase or entitlement verification',
              content: {
                'text/markdown': {
                  schema: { type: 'string' }
                }
              }
            },
            '402': {
              description: 'Payment required',
              content: {
                'application/json': {
                  schema: { type: 'object' }
                }
              }
            }
          },
          'x-pullmd-payment': {
            protocol: 'x402',
            payment_signature_header: 'PAYMENT-SIGNATURE',
            receipt_header: 'X-PURCHASE-RECEIPT',
            docs: `${baseUrl}/WEBMCP.md`
          }
        }
      },
      '/api/mcp/manifest': {
        get: {
          operationId: 'getMcpManifest',
          summary: 'Get MCP service metadata manifest',
          responses: {
            '200': {
              description: 'MCP manifest',
              content: {
                'application/json': {
                  schema: { type: 'object' }
                }
              }
            }
          }
        }
      }
    }
  };
}

export default function handler(req, res) {
  setDiscoveryHeaders(res, req);
  res.setHeader('Content-Type', openApiContentType());
  res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=900, stale-while-revalidate=86400');

  if (req.method === 'OPTIONS') {
    res.setHeader('Allow', 'GET, HEAD, OPTIONS');
    return res.status(200).end();
  }

  if (req.method === 'HEAD') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET, HEAD, OPTIONS');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const baseUrl = resolveBaseUrl(req.headers || {});
  return res.status(200).json(buildOpenApiDocument(baseUrl));
}
