import { getMcpToolsForManifest } from '../_lib/mcp_tools.js';
import { getMcpServerMetadata } from '../_lib/mcp_sdk.js';

export default function handler(req, res) {
  const allowedOrigins = [
    'https://soulstarter.vercel.app',
    'https://soulstarter.io',
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

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const host = String(req.headers['x-forwarded-host'] || req.headers.host || 'soulstarter.vercel.app').trim();
  const proto = String(req.headers['x-forwarded-proto'] || 'https').trim();
  const baseUrl = `${proto}://${host}`;

  const tools = getMcpToolsForManifest();
  const mcpMetadata = getMcpServerMetadata();

  return res.status(200).json({
    schema_version: 'v1',
    name: 'PULL.md',
    description: 'Markdown asset marketplace with x402 payments and receipt-first redownloads',
    url: baseUrl,
    auth: {
      type: 'x402',
      network: 'eip155:8453',
      currency: 'USDC',
      headers: [
        'PAYMENT-SIGNATURE',
        'PAYMENT-REQUIRED',
        'PAYMENT-RESPONSE',
        'X-CLIENT-MODE',
        'X-WALLET-ADDRESS',
        'X-ASSET-TRANSFER-METHOD'
      ],
      deprecated_headers: ['PAYMENT', 'X-PAYMENT'],
      client_mode_headers: ['X-CLIENT-MODE'],
      strict_agent_mode_value: 'agent',
      redownload_headers: [
        'X-WALLET-ADDRESS',
        'X-PURCHASE-RECEIPT',
        'X-REDOWNLOAD-SIGNATURE',
        'X-REDOWNLOAD-TIMESTAMP',
        'X-REDOWNLOAD-SESSION',
        'X-AUTH-SIGNATURE',
        'X-AUTH-TIMESTAMP'
      ],
      redownload_modes: {
        agent_primary: ['X-WALLET-ADDRESS', 'X-PURCHASE-RECEIPT', 'X-REDOWNLOAD-SIGNATURE', 'X-REDOWNLOAD-TIMESTAMP'],
        human_session_recovery: ['X-WALLET-ADDRESS', 'X-REDOWNLOAD-SESSION'],
        human_signed_recovery: ['X-WALLET-ADDRESS', 'X-AUTH-SIGNATURE', 'X-AUTH-TIMESTAMP']
      },
      redownload_session_endpoint: '/api/auth/session',
      redownload_session_bootstrap_headers: ['X-WALLET-ADDRESS', 'X-AUTH-SIGNATURE', 'X-AUTH-TIMESTAMP'],
      purchase_header_preference: ['PAYMENT-SIGNATURE'],
      ownership_auth_signature_preferred: 'eip4361_siwe_message',
      ownership_auth_note:
        'Ownership checks (creator/moderator/session/agent re-download challenge) require SIWE (EIP-4361) message signatures (no token transfer/approval). EOA and EIP-1271 smart-contract wallets are supported.',
      ownership_auth_timestamp_formats: ['unix_ms', 'iso8601'],
      ownership_auth_message_tolerance: ['lf', 'crlf', 'trailing_newline'],
      ownership_auth_timestamp_rule:
        'Use auth_timestamp = Date.parse(Issued At) from the same auth_message_template. Do not use current wall-clock timestamp.',
      purchase_receipt_security:
        'Persist X-PURCHASE-RECEIPT securely per wallet+soul. Treat it as sensitive proof material. Never publish, share, or store in plaintext logs.',
      common_auth_mistakes: [
        'Using Date.now() instead of Date.parse(Issued At)',
        'Reconstructing SIWE text manually instead of signing exact template',
        'Wallet casing mismatch between signed message and submitted fields'
      ],
      agent_key_boundary:
        'Never send Bankr API keys or signer secrets to SoulStarter. SoulStarter accepts only signed x402 payment headers.'
    },
    facilitator_capabilities: {
      runtime_source: 'server-configured facilitator URLs',
      strict_agent_default_transfer_method: 'eip3009',
      note:
        'Current deployment defaults strict agent purchases to eip3009. permit2 can be requested explicitly but may fail upstream depending on facilitator policy.'
    },
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
      scheme: 'soulstarter://',
      examples: [
        'soulstarter://docs/manifest',
        'soulstarter://docs/webmcp',
        'soulstarter://assets',
        'soulstarter://assets/<id>',
        'soulstarter://souls',
        'soulstarter://souls/<id>'
      ]
    },
    tools,
    download_contract: {
      canonical_base_url: baseUrl,
      endpoint_pattern: '/api/assets/{id}/download',
      endpoint_pattern_legacy: '/api/souls/{id}/download',
      method: 'GET',
      flow_profiles: {
        headless_agent: {
          purchase:
            'GET /api/assets/{id}/download with X-CLIENT-MODE: agent -> 402 + PAYMENT-REQUIRED -> retry with PAYMENT-SIGNATURE',
          redownload:
            'GET /api/assets/{id}/download with X-CLIENT-MODE: agent + X-WALLET-ADDRESS + X-PURCHASE-RECEIPT + X-REDOWNLOAD-SIGNATURE + X-REDOWNLOAD-TIMESTAMP'
        },
        human_browser: {
          purchase: 'Connect wallet in UI and submit x402 payment',
          redownload: 'Receipt-first, with optional session bootstrap at /api/auth/session for recovery UX'
        }
      },
      canonical_purchase_flow:
        'GET /api/assets/{id}/download is the authoritative x402 flow for payment requirements and paid retry. Legacy /api/souls/{id}/download remains supported.',
      first_request:
        'No payment headers -> returns 402 + PAYMENT-REQUIRED. Include X-WALLET-ADDRESS on this first request for strict wallet binding and deterministic retries.',
      claim_request: 'Include PAYMENT-SIGNATURE with base64-encoded x402 payload to claim entitlement and download',
      receipt_persistence:
        'Persist X-PURCHASE-RECEIPT from successful 200 responses in secure storage keyed by wallet+soul. Do not treat receipt values as public.',
      signing_instructions_field:
        '402 response bodies include payment_signing_instructions with transfer-method-specific required/forbidden fields and typed-data primary type.',
      payment_payload_contract: {
        top_level_required: ['x402Version', 'scheme', 'network', 'accepted', 'payload'],
        eip3009_payload_required: ['payload.authorization', 'payload.signature'],
        eip3009_payload_forbidden: ['payload.authorization.signature', 'payload.permit2Authorization', 'payload.transaction'],
        notes: [
          'accepted must exactly equal PAYMENT-REQUIRED.accepts[0]',
          'scheme/network must be top-level (not nested under payload)'
        ]
      },
      redownload_request:
        'Headless agents should send X-CLIENT-MODE: agent + X-WALLET-ADDRESS + X-PURCHASE-RECEIPT + X-REDOWNLOAD-SIGNATURE + X-REDOWNLOAD-TIMESTAMP. Human/browser flow can use recovery mode.',
      strict_agent_mode:
        'When X-CLIENT-MODE=agent is set, re-download requires receipt plus wallet signature challenge headers. Session/auth recovery headers are rejected.',
      redownload_session_bootstrap:
        'Bootstrap session at GET /api/auth/session with X-WALLET-ADDRESS + X-AUTH-SIGNATURE + X-AUTH-TIMESTAMP to obtain X-REDOWNLOAD-SESSION.',
      anti_poisoning_rule:
        'Always verify the full PAYMENT-REQUIRED.accepts[0].payTo address against the canonical seller address from trusted SoulStarter metadata before signing.',
      redownload_priority:
        'If wallet+receipt headers are present, entitlement path is processed first (prevents accidental repay even when payment headers are also sent).',
      note: 'auth_message_template may appear in a 402 response as helper text; purchase still requires payment header submission.',
      domain_note: 'Use the canonical production host (pull.md or current deployment host). Preview/alias domains may not reflect the latest contract behavior.',
      v2_requirement: 'Submitted payment JSON must include accepted matching PAYMENT-REQUIRED.accepts[0] exactly.',
      method_discipline:
        'Submit exactly one payload method branch. eip3009 => authorization+signature only. permit2 => permit2Authorization(+transaction)+signature only.',
      transfer_method_selection:
        'Strict agent mode defaults to eip3009. Optional explicit override: X-ASSET-TRANSFER-METHOD (eip3009|permit2).',
      facilitator_note:
        'permit2 may fail upstream depending on facilitator policy. eip3009 is the stable default in this deployment.',
      duplicate_settlement_protection:
        'Server applies single-flight settlement idempotency by payer+soul+nonce to reduce duplicate charge attempts from repeated submissions.',
      wallet_runtime_note:
        'EmblemVault currently has verified successful purchase + re-download runs. Bankr eip3009 remains experimental.',
      auth_challenge_recommendation:
        'For creator/moderator/session/redownload auth, call MCP tool get_auth_challenge first, then sign the exact auth_message_template and set auth_timestamp = Date.parse(Issued At).',
      permit2_pitfalls: [
        'Set top-level network to accepted.network (eip155:8453), not "base".',
        'Use payload.permit2Authorization (not payload.permit2).',
        'Do not include payload.authorization in permit2 mode.',
        'Send permit2 numeric fields as strings.',
        'Set payload.transaction.data to ERC20 approve calldata; do not send empty 0x.'
      ]
    },
    contact: {
      name: 'PULL.md Support',
      url: baseUrl
    }
  });
}
