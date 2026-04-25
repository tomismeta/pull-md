import { getMcpToolsForManifest } from '../_lib/mcp_tools.js';
import { getMcpServerMetadata } from '../_lib/mcp_sdk.js';
import { setDiscoveryHeaders } from '../_lib/discovery.js';
import { handleHomepageRequest } from '../_lib/homepage.js';
import {
  buildAuthContract,
  buildCommerceContract,
  buildDiscoveryUrls,
  buildDownloadContract,
  buildFacilitatorCapabilities,
  buildMarketplaceProfile
} from '../_lib/public_contract.js';
import { resolveSiteContext } from '../_lib/site_url.js';

export default function handler(req, res) {
  const { baseUrl } = resolveSiteContext(req.headers || {});

  if (String(req.query?.view || '').trim().toLowerCase() === 'home') {
    return handleHomepageRequest({ req, res, baseUrl });
  }

  const allowedOrigins = [
    'https://pullmd.vercel.app',
    'https://pullmd.io',
    'https://pull.md',
    'https://www.pull.md',
    'http://localhost:3000',
    'http://localhost:8080'
  ];

  const origin = req.headers.origin;
  if (allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }

  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Content-Type', 'application/json');
  setDiscoveryHeaders(res, req);

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const tools = getMcpToolsForManifest();
  const mcpMetadata = getMcpServerMetadata();
  const discovery = buildDiscoveryUrls(baseUrl);
  const commerce = buildCommerceContract();
  const auth = buildAuthContract();
  const facilitatorCapabilities = buildFacilitatorCapabilities();
  const downloadContract = buildDownloadContract(baseUrl);

  return res.status(200).json({
    schema_version: 'v1',
    name: 'PULL.md',
    description: 'Markdown asset marketplace with x402 payments and receipt-first redownloads',
    url: baseUrl,
    discovery: {
      api_catalog: discovery.api_catalog,
      public_catalog: discovery.public_catalog,
      canonical_purchase_endpoint_pattern: discovery.canonical_purchase_endpoint_pattern,
      mcp_server_card: discovery.mcp_server_card,
      agent_skills: discovery.agent_skills,
      service_desc: discovery.openapi,
      service_doc: discovery.webmcp_markdown,
      service_meta: discovery.mcp_manifest
    },
    marketplace: buildMarketplaceProfile(),
    commerce,
    auth,
    facilitator_capabilities: facilitatorCapabilities,
    error_codes: {
      agent_wallet_hint_required:
        'Strict agent purchase quote missing X-WALLET-ADDRESS (or wallet_address query).',
      agent_wallet_hint_required_paid_retry:
        'Strict agent paid retry missing X-WALLET-ADDRESS (or wallet_address query).',
      x402_method_mismatch:
        'Submitted payment method branch does not match wallet-quote transfer method.',
      invalid_agent_redownload_signature:
        'Strict agent redownload SIWE signature invalid or timestamp format mismatch.',
      receipt_required_agent_mode:
        'Strict agent redownload requires receipt + challenge signature headers.'
    },
    wallet_compatibility: {
      as_of: '2026-02-14',
      supported_browser_wallets: ['MetaMask', 'Rabby', 'Bankr Wallet'],
      recommended_for_purchase: 'MetaMask or Rabby',
      bankr_status: 'experimental',
      bankr_note:
        'Bankr EIP-3009 signatures may fail USDC contract verification in this flow (FiatTokenV2: invalid signature). Prefer EmblemVault until upstream signer compatibility is fixed.'
    },
    mcp: {
      endpoint: mcpMetadata.endpoint,
      transport: mcpMetadata.transport,
      protocol_version: mcpMetadata.protocolVersion,
      response_streaming: mcpMetadata.response_streaming,
      sampling: mcpMetadata.sampling,
      required_request_headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream'
      },
      methods: mcpMetadata.methods
    },
    prompts: {
      challenge_first_tool: 'get_auth_challenge',
      note:
        'Use get_auth_challenge to receive SIWE text + timestamp before signing creator/moderator/session/redownload auth requests.'
    },
    resources: {
      scheme: 'pullmd://',
      examples: [
        'pullmd://docs/manifest',
        'pullmd://docs/webmcp',
        'pullmd://assets',
        'pullmd://assets/<id>'
      ],
      legacy_alias_scheme: null
    },
    tools,
    download_contract: downloadContract,
    contact: {
      name: 'PULL.md Support',
      url: baseUrl
    }
  });
}
