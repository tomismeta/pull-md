import {
  assetIdsResolved,
  getAssetResolved,
  getSoulResolved,
  listAssetsResolved,
  listSoulsResolved,
  soulIdsResolved
} from '../catalog.js';
import { buildSiweAuthMessage, getSellerAddress, verifyPurchaseReceipt } from '../payments.js';
import { AppError } from '../errors.js';

function enabledAssetTypes() {
  const raw = String(process.env.ENABLED_MARKDOWN_ASSET_TYPES || 'soul,skill')
    .split(',')
    .map((item) => String(item || '').trim().toLowerCase())
    .filter(Boolean);
  return new Set(raw.length ? raw : ['soul', 'skill']);
}

function isEnabledAssetType(value) {
  return enabledAssetTypes().has(String(value || '').trim().toLowerCase());
}

function matchesAssetType(item, assetType) {
  const target = String(assetType || '').trim().toLowerCase();
  if (!target) return true;
  return String(item?.asset_type || '').toLowerCase() === target;
}

export async function listAssetsCatalog({ category, assetType } = {}) {
  const assets = await listAssetsResolved();
  return assets.filter((asset) => {
    if (!isEnabledAssetType(asset.asset_type)) return false;
    if (category && asset.category !== category) return false;
    return matchesAssetType(asset, assetType);
  });
}

export async function listSoulsCatalog({ category } = {}) {
  return listAssetsCatalog({ category, assetType: 'soul' });
}

export function buildMcpListAssetsResponse(assets) {
  return {
    assets,
    souls: assets,
    count: assets.length,
    meta: {
      agent_friendly: true,
      access_type: 'x402_paywall',
      flow: 'GET /api/assets/{id}/download -> 402 PAYMENT-REQUIRED -> GET with PAYMENT-SIGNATURE',
      reauth_flow:
        'Strict headless agent: X-CLIENT-MODE: agent + X-WALLET-ADDRESS + X-PURCHASE-RECEIPT + X-REDOWNLOAD-SIGNATURE + X-REDOWNLOAD-TIMESTAMP. Human recovery: X-WALLET-ADDRESS + X-REDOWNLOAD-SESSION (or signed fallback).',
      receipt_handling:
        'Persist X-PURCHASE-RECEIPT securely per wallet+asset. Treat it as sensitive proof material and do not log/share plaintext values.'
    }
  };
}

export function buildMcpListSoulsResponse(souls) {
  return buildMcpListAssetsResponse(souls);
}

export function buildPublicAssetsResponse(assets) {
  return {
    assets,
    souls: assets,
    count: assets.length,
    meta: {
      discovery: 'public_catalog',
      mcp_manifest: '/api/mcp/manifest',
      mcp_endpoint: '/mcp',
      mcp_list_tool: 'list_assets',
      enabled_asset_types: [...enabledAssetTypes()],
      purchase_flow: 'GET /api/assets/{id}/download -> 402 PAYMENT-REQUIRED -> retry with PAYMENT-SIGNATURE'
    }
  };
}

export function buildPublicSoulsResponse(souls) {
  const body = buildPublicAssetsResponse(souls);
  return {
    ...body,
    souls: body.assets,
    meta: {
      ...body.meta,
      mcp_list_tool: 'list_souls',
      purchase_flow: 'GET /api/assets/{id}/download -> 402 PAYMENT-REQUIRED -> retry with PAYMENT-SIGNATURE'
    }
  };
}

export async function resolveAssetDetails(id) {
  const assetId = String(id || '').trim();
  if (!assetId) {
    throw new AppError(400, { error: 'Missing required parameter: id' });
  }

  const asset = await getAssetResolved(assetId);
  if (!asset) {
    const ids = await assetIdsResolved();
    throw new AppError(404, {
      error: 'Asset not found',
      available_assets: ids,
      available_souls: ids
    });
  }
  const summary = (await listAssetsResolved()).find((item) => item.id === assetId) || null;
  const resolvedAssetType = String(asset.asset_type || asset.assetType || summary?.asset_type || '')
    .trim()
    .toLowerCase();
  if (!isEnabledAssetType(resolvedAssetType)) {
    throw new AppError(404, {
      error: 'Asset not found',
      reason: 'asset_type_not_enabled',
      enabled_asset_types: [...enabledAssetTypes()]
    });
  }

  const sellerAddress = asset.sellerAddress || getSellerAddress();
  return { assetId, soulId: assetId, asset, soul: asset, summary, sellerAddress };
}

export async function resolveSoulDetails(id) {
  return resolveAssetDetails(id);
}

export function buildMcpAssetDetailsResponse({ assetId, soulId, asset, soul, summary, sellerAddress }) {
  const effectiveAsset = asset || soul || {};
  const id = String(assetId || soulId || summary?.id || effectiveAsset.id || '').trim();
  const fileName =
    String(summary?.file_name || effectiveAsset.fileName || effectiveAsset.file_name || '').trim() || 'SOUL.md';
  return {
    asset: {
      ...summary,
      long_description: effectiveAsset.longDescription,
      files: [fileName],
      purchase_endpoint: `/api/assets/${id}/download`,
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
        note:
          'Strict headless mode requires receipt + wallet signature challenge for re-download. Session/auth recovery headers are not used.',
        receipt_security:
          'Store X-PURCHASE-RECEIPT securely and never expose it in logs, analytics, prompts, or shared transcripts.'
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
        receipt_persistence_hint:
          'After successful purchase, persist X-PURCHASE-RECEIPT in secure storage. This wallet-scoped proof is required for strict no-repay re-download.',
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
          soulId: id,
          action: 'redownload',
          timestamp: Date.now(),
          domain: 'www.pull.md',
          uri: 'https://www.pull.md'
        }),
        session: buildSiweAuthMessage({
          wallet: '0x<your-wallet>',
          soulId: '*',
          action: 'session',
          timestamp: Date.now(),
          domain: 'www.pull.md',
          uri: 'https://www.pull.md'
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
    soul: {
      ...summary,
      long_description: effectiveAsset.longDescription,
      files: [fileName],
      purchase_endpoint: `/api/assets/${id}/download`,
      payment_protocol: 'x402',
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

export function buildMcpSoulDetailsResponse(details) {
  return buildMcpAssetDetailsResponse(details);
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
      message: 'Provide proofs: [{ asset_id|soul_id, receipt }]'
    });
  }

  const availableAssetIds = await assetIdsResolved();
  const results = await Promise.all(
    proofList.map(async (proof) => {
      const assetId = String(proof?.asset_id || proof?.soul_id || '');
      const receipt = String(proof?.receipt || '');

      const asset = await getAssetResolved(assetId);
      if (!asset) {
        return {
          asset_id: assetId,
          soul_id: assetId,
          entitled: false,
          reason: 'Unknown asset',
          available_assets: availableAssetIds,
          available_souls: availableAssetIds
        };
      }

      const check = verifyPurchaseReceipt({
        receipt,
        wallet,
        soulId: assetId
      });

      return {
        asset_id: assetId,
        soul_id: assetId,
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
