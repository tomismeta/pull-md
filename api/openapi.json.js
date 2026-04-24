import { openApiContentType, resolveBaseUrl, setDiscoveryHeaders } from './_lib/discovery.js';
import { buildAuthContract, buildCommerceContract, buildDiscoveryUrls } from './_lib/public_contract.js';

function buildOpenApiDocument(baseUrl) {
  const discovery = buildDiscoveryUrls(baseUrl);
  const auth = buildAuthContract();
  const commerce = buildCommerceContract();
  return {
    openapi: '3.1.0',
    info: {
      title: 'PULL.md REST API',
      version: '1.0.0',
      summary: 'REST discovery and commerce endpoints for PULL.md',
      description:
        'REST surface for public catalog discovery and canonical x402 purchase/re-download delivery. MCP transport is exposed separately at /mcp. OAuth/OIDC discovery metadata is intentionally absent in this deployment: protected flows do not use bearer tokens, wallet identity uses SIWE (EIP-4361), and payment/entitlement delivery use x402 plus receipt-bound headers.',
      contact: {
        name: 'PULL.md Support',
        url: `${baseUrl}/WEBMCP.md`
      }
    },
    'x-pullmd-auth-model': {
      payment_protocol: auth.payment_protocol,
      wallet_identity_auth: auth.identity_auth,
      oauth2_supported: auth.oauth2_supported,
      oidc_supported: auth.oidc_supported,
      note:
        'Protected flows do not use OAuth bearer tokens in this deployment. Use SIWE for wallet identity/auth and x402 plus receipt-bound headers for payment and re-download.'
    },
    'x-pullmd-commerce': commerce,
    servers: [{ url: baseUrl }],
    paths: {
      '/api/assets': {
        get: {
          operationId: 'listAssets',
          summary: 'List public assets',
          description:
            'Returns the current public markdown asset catalog. Each item advertises `purchase_endpoint` and `payment_protocol` so agents can transition directly into the canonical x402 flow.',
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
            payment_required_header: 'PAYMENT-REQUIRED',
            payment_response_header: 'PAYMENT-RESPONSE',
            paywall_status_code: 402,
            bazaar_discovery_declared: true,
              docs: discovery.webmcp_markdown
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
