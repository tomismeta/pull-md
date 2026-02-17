import { getSoulResolved, listSoulsResolved, soulIdsResolved } from '../catalog.js';
import { buildSiweAuthMessage, getSellerAddress, verifyPurchaseReceipt } from '../payments.js';
import { AppError } from '../errors.js';

export async function listSoulsCatalog({ category } = {}) {
  const souls = await listSoulsResolved();
  return category ? souls.filter((soul) => soul.category === category) : souls;
}

export function buildMcpListSoulsResponse(souls) {
  return {
    souls,
    count: souls.length,
    meta: {
      agent_friendly: true,
      access_type: 'x402_paywall',
      flow: 'GET /api/souls/{id}/download -> 402 PAYMENT-REQUIRED -> GET with PAYMENT-SIGNATURE',
      reauth_flow:
        'Strict headless agent: X-CLIENT-MODE: agent + X-WALLET-ADDRESS + X-PURCHASE-RECEIPT + X-REDOWNLOAD-SIGNATURE + X-REDOWNLOAD-TIMESTAMP. Human recovery: X-WALLET-ADDRESS + X-REDOWNLOAD-SESSION (or signed fallback).'
    }
  };
}

export function buildPublicSoulsResponse(souls) {
  return {
    souls,
    count: souls.length,
    meta: {
      discovery: 'public_catalog',
      mcp_manifest: '/api/mcp/manifest',
      mcp_endpoint: '/mcp',
      mcp_list_tool: 'list_souls',
      purchase_flow: 'GET /api/souls/{id}/download -> 402 PAYMENT-REQUIRED -> retry with PAYMENT-SIGNATURE'
    }
  };
}

export async function resolveSoulDetails(id) {
  const soulId = String(id || '').trim();
  if (!soulId) {
    throw new AppError(400, { error: 'Missing required parameter: id' });
  }

  const soul = await getSoulResolved(soulId);
  if (!soul) {
    throw new AppError(404, { error: 'Soul not found', available_souls: await soulIdsResolved() });
  }

  const summary = (await listSoulsResolved()).find((item) => item.id === soulId) || null;
  const sellerAddress = soul.sellerAddress || getSellerAddress();
  return { soulId, soul, summary, sellerAddress };
}

export function buildMcpSoulDetailsResponse({ soulId, soul, summary, sellerAddress }) {
  return {
    soul: {
      ...summary,
      long_description: soul.longDescription,
      files: ['SOUL.md'],
      purchase_endpoint: `/api/souls/${soulId}/download`,
      payment_protocol: 'x402',
      auth_headers: {
        purchase: ['PAYMENT-SIGNATURE', 'X-WALLET-ADDRESS', 'X-ASSET-TRANSFER-METHOD'],
        auth_challenge_tool: ['POST /mcp', 'tools/call', 'name=get_auth_challenge'],
        deprecated_purchase_headers: ['PAYMENT', 'X-PAYMENT'],
        client_mode: ['X-CLIENT-MODE'],
        strict_agent_purchase: ['X-CLIENT-MODE', 'PAYMENT-SIGNATURE'],
        redownload_primary: ['X-WALLET-ADDRESS', 'X-PURCHASE-RECEIPT'],
        strict_agent_redownload: [
          'X-CLIENT-MODE',
          'X-WALLET-ADDRESS',
          'X-PURCHASE-RECEIPT',
          'X-REDOWNLOAD-SIGNATURE',
          'X-REDOWNLOAD-TIMESTAMP'
        ],
        redownload_session_recovery: ['X-WALLET-ADDRESS', 'X-REDOWNLOAD-SESSION'],
        redownload_signed_recovery: ['X-WALLET-ADDRESS', 'X-AUTH-SIGNATURE', 'X-AUTH-TIMESTAMP'],
        redownload_session_bootstrap: ['X-WALLET-ADDRESS', 'X-AUTH-SIGNATURE', 'X-AUTH-TIMESTAMP']
      },
      redownload_session_endpoint: '/api/auth/session',
      strict_agent_mode: {
        header: 'X-CLIENT-MODE',
        value: 'agent',
        note: 'Strict headless mode requires receipt + wallet signature challenge for re-download. Session/auth recovery headers are not used.'
      },
      payment_payload_contract: {
        top_level_required: ['x402Version', 'scheme', 'network', 'accepted', 'payload'],
        eip3009_required: ['payload.authorization', 'payload.signature'],
        eip3009_forbidden: ['payload.authorization.signature', 'payload.permit2Authorization', 'payload.transaction'],
        note: 'Use accepted exactly as returned in PAYMENT-REQUIRED.accepts[0]. Keep scheme/network at top level. Strict agent mode defaults to eip3009; use X-ASSET-TRANSFER-METHOD only when you intentionally need override behavior.'
      },
      payment_signing_instructions: {
        required_header: 'PAYMENT-SIGNATURE',
        header_format: 'base64(JSON.stringify(x402_payload))',
        required_top_level_fields: ['x402Version', 'scheme', 'network', 'accepted', 'payload'],
        accepted_must_match: 'accepted must exactly equal PAYMENT-REQUIRED.accepts[0]',
        wallet_hint: 'Send X-WALLET-ADDRESS on paywall and paid retry requests for strict wallet binding and deterministic retries.',
        method_rules: {
          eip3009: {
            typed_data_primary_type: 'TransferWithAuthorization',
            required_payload_fields: ['payload.authorization', 'payload.signature'],
            forbidden_payload_fields: ['payload.authorization.signature', 'payload.permit2Authorization', 'payload.transaction'],
            authorization_fields: ['from', 'to', 'value', 'validAfter', 'validBefore', 'nonce']
          },
          permit2: {
            typed_data_primary_type: 'PermitWitnessTransferFrom',
            required_payload_fields: ['payload.from', 'payload.permit2Authorization', 'payload.transaction', 'payload.signature'],
            forbidden_payload_fields: ['payload.authorization', 'payload.permit2'],
            permit2_authorization_fields: [
              'from',
              'permitted.token',
              'permitted.amount',
              'spender',
              'nonce',
              'deadline',
              'witness.to',
              'witness.validAfter',
              'witness.extra'
            ]
          }
        }
      },
      auth_message_examples: {
        redownload: buildSiweAuthMessage({
          wallet: '0x<your-wallet>',
          soulId,
          action: 'redownload',
          timestamp: Date.now()
        }),
        session: buildSiweAuthMessage({
          wallet: '0x<your-wallet>',
          soulId: '*',
          action: 'session',
          timestamp: Date.now()
        })
      },
      auth_timestamp_note:
        'For SIWE ownership auth, set timestamp to Date.parse(Issued At) from the same server-issued auth template.',
      common_auth_mistakes: [
        'Using Date.now() instead of Date.parse(Issued At)',
        'Rebuilding SIWE text manually instead of signing exact template',
        'Wallet case mismatch between signed message and request arguments'
      ],
      seller_address: sellerAddress
    },
    meta: {
      agent_friendly: true,
      purchase_flow: 'x402',
      documentation: '/api/mcp/manifest',
      wallet_compatibility: {
        as_of: '2026-02-14',
        supported_browser_wallets: ['MetaMask', 'Rabby', 'Bankr Wallet'],
        bankr_status: 'experimental',
        bankr_note: 'Known issue: EIP-3009 signatures can fail with FiatTokenV2: invalid signature in this flow.'
      }
    }
  };
}

export async function checkReceiptEntitlements({ walletAddress, proofs }) {
  const wallet = String(walletAddress || '').trim().toLowerCase();
  if (!/^0x[a-f0-9]{40}$/i.test(wallet)) {
    throw new AppError(400, { error: 'Invalid or missing wallet_address' });
  }

  const proofList = Array.isArray(proofs) ? proofs : [];
  if (proofList.length === 0) {
    throw new AppError(400, {
      error: 'Missing proofs',
      message: 'Provide proofs: [{ soul_id, receipt }]'
    });
  }

  const availableSoulIds = await soulIdsResolved();
  const results = await Promise.all(
    proofList.map(async (proof) => {
      const soulId = String(proof?.soul_id || '');
      const receipt = String(proof?.receipt || '');

      const soul = await getSoulResolved(soulId);
      if (!soul) {
        return {
          soul_id: soulId,
          entitled: false,
          reason: 'Unknown soul',
          available_souls: availableSoulIds
        };
      }

      const check = verifyPurchaseReceipt({
        receipt,
        wallet,
        soulId
      });

      return {
        soul_id: soulId,
        entitled: check.ok,
        reason: check.ok ? null : check.error,
        transaction: check.transaction || null
      };
    })
  );

  return {
    wallet_address: wallet,
    entitlements: results,
    total_entitled: results.filter((item) => item.entitled).length
  };
}
