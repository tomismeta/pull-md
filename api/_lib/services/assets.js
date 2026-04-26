import {
  assetIdsResolved,
  getAssetResolved,
  listAssetsResolved
} from '../catalog.js';
import {
  defaultFileNameForAssetType,
  enabledAssetTypes,
  isEnabledAssetType
} from '../asset_metadata.js';
import { canonicalProductionBaseUrl, canonicalProductionHost } from '../site_url.js';
import { buildPublicAssetsMeta } from '../public_contract.js';
import { buildSiweAuthMessage, getSellerAddress, verifyPurchaseReceipt } from '../payments.js';
import { AppError } from '../errors.js';

function matchesAssetType(item, assetType) {
  const target = String(assetType || '').trim().toLowerCase();
  if (!target) return true;
  return String(item?.asset_type || '').toLowerCase() === target;
}

function normalizeScanState(input) {
  const asset = input && typeof input === 'object' ? input : {};
  const verdict = String(asset.scan_verdict || asset?.scan?.verdict || '').trim().toLowerCase();
  const mode = String(asset.scan_mode || asset?.scan?.mode || '').trim().toLowerCase() || null;
  const scannerEngine = String(asset.scan_scanner_engine || asset?.scan?.scannerEngine || '').trim() || null;
  const scannerRuleset = String(asset.scan_scanner_ruleset || asset?.scan?.scannerRuleset || '').trim() || null;
  const scannerFingerprint =
    String(asset.scan_scanner_fingerprint || asset?.scan?.scannerFingerprint || '').trim() || null;
  const scannedAt = String(asset.scan_scanned_at || asset?.scan?.scannedAt || '').trim() || null;
  const blocked = Boolean(asset.scan_blocked || asset?.scan?.blocked);
  const summary =
    asset.scan_summary && typeof asset.scan_summary === 'object'
      ? asset.scan_summary
      : asset?.scan?.summary && typeof asset.scan.summary === 'object'
        ? asset.scan.summary
        : null;

  const scanState = verdict || 'unscanned';
  return {
    ...asset,
    scan_verdict: verdict || null,
    scan_mode: mode,
    scan_scanner_engine: scannerEngine,
    scan_scanner_ruleset: scannerRuleset,
    scan_scanner_fingerprint: scannerFingerprint,
    scan_scanned_at: scannedAt,
    scan_blocked: blocked,
    scan_summary: summary,
    scan_state: scanState
  };
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
  const normalized = Array.isArray(assets) ? assets.map((asset) => normalizeScanState(asset)) : [];
  return {
    assets: normalized,
    count: normalized.length,
    meta: {
      agent_friendly: true,
      access_type: 'x402_paywall',
      flow: 'GET /api/assets/{id}/download -> 402 PAYMENT-REQUIRED -> GET with PAYMENT-SIGNATURE',
      security_scan_policy:
        'Publish/edit triggers markdown security scanning. In advisory mode findings are returned but publish can continue; in enforce mode critical findings block publish/edit.',
      reauth_flow:
        'Strict headless agent: X-CLIENT-MODE: agent + X-WALLET-ADDRESS + (X-PURCHASE-RECEIPT or X-BLOCKCHAIN-TRANSACTION) + X-REDOWNLOAD-SIGNATURE + X-REDOWNLOAD-TIMESTAMP. Human recovery: X-WALLET-ADDRESS + X-REDOWNLOAD-SESSION (or signed fallback).',
      receipt_handling:
        'Persist X-PURCHASE-RECEIPT securely per wallet+asset. Also retain X-BLOCKCHAIN-TRANSACTION or PAYMENT-RESPONSE.transaction as a non-secret recovery pointer. Do not log/share plaintext receipt values.'
    }
  };
}

export function buildPublicAssetsResponse(assets) {
  return {
    assets,
    count: assets.length,
    meta: buildPublicAssetsMeta()
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
      available_assets: ids
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
      enabled_asset_types: enabledAssetTypes()
    });
  }

  const sellerAddress = asset.sellerAddress || getSellerAddress();
  return { assetId, asset, summary, sellerAddress };
}

export function buildMcpAssetDetailsResponse({ assetId, asset, summary, sellerAddress }) {
  const effectiveAsset = asset || {};
  const id = String(assetId || summary?.id || effectiveAsset.id || '').trim();
  const normalizedSummary = normalizeScanState(summary || {});
  const fileName =
    String(normalizedSummary?.file_name || effectiveAsset.fileName || effectiveAsset.file_name || '').trim() ||
    defaultFileNameForAssetType(normalizedSummary?.asset_type || effectiveAsset.assetType || effectiveAsset.asset_type);
  return {
    asset: {
      ...normalizedSummary,
      long_description: effectiveAsset.longDescription,
      files: [fileName],
      purchase_endpoint: `/api/assets/${id}/download`,
      payment_protocol: 'x402',
      security_scan_policy:
        'Scan runs automatically on publish/edit. scan_state is one of unscanned|clean|warn|block.',
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
        strict_agent_redownload_transaction: [
          'X-CLIENT-MODE',
          'X-WALLET-ADDRESS',
          'X-BLOCKCHAIN-TRANSACTION',
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
          'Strict headless mode requires receipt or blockchain transaction reference plus wallet signature challenge for re-download. Session/auth recovery headers are not used.',
        receipt_security:
          'Store X-PURCHASE-RECEIPT securely and never expose it in logs, analytics, prompts, or shared transcripts. X-BLOCKCHAIN-TRANSACTION is safe to retain as a non-secret recovery pointer, but it is not a standalone proof.'
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
          'After successful purchase, persist X-PURCHASE-RECEIPT in secure storage. Also retain the settlement transaction hash from PAYMENT-RESPONSE.transaction or X-BLOCKCHAIN-TRANSACTION for recovery. The receipt is secret proof; the transaction hash is a secondary public pointer.',
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
          assetId: id,
          action: 'redownload',
          timestamp: Date.now(),
          domain: canonicalProductionHost(),
          uri: canonicalProductionBaseUrl()
        }),
        session: buildSiweAuthMessage({
          wallet: '0x<your-wallet>',
          assetId: '*',
          action: 'session',
          timestamp: Date.now(),
          domain: canonicalProductionHost(),
          uri: canonicalProductionBaseUrl()
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
      message: 'Provide proofs: [{ asset_id, receipt }]'
    });
  }

  const availableAssetIds = await assetIdsResolved();
  const results = await Promise.all(
    proofList.map(async (proof) => {
      const assetId = String(proof?.asset_id || '');
      const receipt = String(proof?.receipt || '');

      const asset = await getAssetResolved(assetId);
      if (!asset) {
        return {
          asset_id: assetId,
          entitled: false,
          reason: 'Unknown asset',
          available_assets: availableAssetIds
        };
      }

      const check = verifyPurchaseReceipt({
        receipt,
        wallet,
        assetId
      });

      return {
        asset_id: assetId,
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
