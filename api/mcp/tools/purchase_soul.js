import { getSoul, soulIds } from '../../_lib/catalog.js';
import { getSellerAddress, setCors } from '../../_lib/payments.js';
import { createRequestContext, getX402HTTPServer } from '../../_lib/x402.js';

export default async function handler(req, res) {
  setCors(res, req.headers.origin);

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { soul_id: soulId, wallet_address: walletAddress } = req.body || {};

  if (!soulId) {
    return res.status(400).json({ error: 'Missing required parameter: soul_id' });
  }

  if (!walletAddress) {
    return res.status(400).json({ error: 'Missing required parameter: wallet_address' });
  }

  if (!/^0x[a-fA-F0-9]{40}$/.test(walletAddress)) {
    return res.status(400).json({ error: 'Invalid wallet address format' });
  }

  const soul = getSoul(soulId);
  if (!soul) {
    return res.status(404).json({ error: 'Soul not found', available_souls: soulIds() });
  }

  const sellerAddress = soul.sellerAddress || getSellerAddress();
  if (!sellerAddress) {
    return res.status(500).json({ error: 'Server configuration error: SELLER_ADDRESS is required' });
  }

  try {
    const httpServer = await getX402HTTPServer({ soulId, soul, sellerAddress });
    const syntheticReq = {
      method: 'GET',
      url: `/api/souls/${soulId}/download`,
      headers: {
        host: req.headers.host || 'soulstarter.vercel.app',
        accept: 'application/json',
        'x-forwarded-proto': req.headers['x-forwarded-proto'] || 'https'
      }
    };
    const result = await httpServer.processHTTPRequest(createRequestContext(syntheticReq));
    if (result.type !== 'payment-error') {
      return res.status(500).json({ error: 'Failed to generate x402 requirements' });
    }

    for (const [key, value] of Object.entries(result.response.headers || {})) {
      if (value != null) {
        res.setHeader(key, value);
      }
    }

    let paymentRequired = null;
    const paymentRequiredHeader = result.response.headers?.['PAYMENT-REQUIRED'] || result.response.headers?.['payment-required'];
    if (paymentRequiredHeader) {
      try {
        paymentRequired = JSON.parse(Buffer.from(paymentRequiredHeader, 'base64').toString('utf-8'));
      } catch (_) {
        paymentRequired = null;
      }
    }

    const body = result.response.body && typeof result.response.body === 'object' ? result.response.body : {};
    return res.status(402).json({
      ...body,
      wallet_address: walletAddress,
      payment: {
        amount: soul.priceDisplay,
        currency: 'USDC',
        network: 'Base',
        recipient: sellerAddress
      },
      instructions: {
        step_1: 'Decode PAYMENT-REQUIRED (base64 JSON) and keep accepts[0] exactly (do not edit fields/order)',
        step_2:
          'Use accepts[0].extra.assetTransferMethod: permit2 -> sign PermitWitnessTransferFrom, eip3009 -> sign TransferWithAuthorization; then build x402 payload including accepted',
        step_3: 'Retry GET /api/souls/{soul_id}/download with header PAYMENT-SIGNATURE (or PAYMENT/X-PAYMENT)',
        step_4: 'On success, store X-PURCHASE-RECEIPT for future re-downloads',
        step_5:
          'For subsequent access, call GET /api/souls/{soul_id}/download with X-WALLET-ADDRESS + X-PURCHASE-RECEIPT and either X-REDOWNLOAD-SESSION (preferred) or signed fallback headers.'
      },
      method_rules: {
        default_for_cdp_base_mainnet: 'eip3009',
        eip3009_only_shape: 'Use payload.authorization + payload.signature only.',
        permit2_only_shape: 'Use payload.permit2Authorization (+ payload.transaction when required) + payload.signature only.',
        never_mix_payload_branches: true
      },
      security_rules: {
        never_share_bankr_key_with_soulstarter: true,
        note: 'Bankr API keys must stay inside the agent/Bankr runtime. SoulStarter only accepts signed x402 payment headers.',
        anti_poisoning:
          'Before signing, verify accepts[0].payTo exactly matches the trusted seller address from SoulStarter metadata. Do not trust truncated addresses from transfer history.'
      },
      header_format: {
        preferred: 'PAYMENT-SIGNATURE: <base64(JSON x402 payload)>',
        accepted_alternatives: ['PAYMENT: <base64(JSON x402 payload)>', 'X-PAYMENT: <base64(JSON x402 payload)>']
      },
      wallet_examples: {
        standard_wallet:
          'If assetTransferMethod=permit2, sign PermitWitnessTransferFrom and include permit2Authorization + transaction. If eip3009, sign TransferWithAuthorization.',
        bankr_wallet:
          'Agent orchestrates locally: call /agent/me, sign with /agent/sign, build base64 JSON payload, and send PAYMENT-SIGNATURE. Never send Bankr API key to SoulStarter. Current status: Bankr eip3009 is experimental in this deployment.'
      },
      wallet_compatibility: {
        as_of: '2026-02-14',
        preferred_for_purchase: 'EmblemVault',
        bankr_known_issue:
          'Bankr EIP-3009 signatures may fail with FiatTokenV2: invalid signature. Use EmblemVault or another compatible signer for production purchase runs.'
      },
      bankr_self_orchestration: {
        step_1: 'Call Bankr GET /agent/me to resolve signing wallet context.',
        step_2:
          'Decode PAYMENT-REQUIRED and copy accepts[0] exactly into payload.accepted. Read accepts[0].extra.assetTransferMethod.',
        step_3:
          'Call Bankr POST /agent/sign (eth_signTypedData_v4) using permit2 or eip3009 typed data as required by assetTransferMethod.',
        step_4:
          'Build x402 JSON (for permit2 include payload.from + payload.permit2Authorization + payload.transaction), base64-encode it, and call GET /api/souls/{soul_id}/download with PAYMENT-SIGNATURE header.',
        step_5: 'Store X-PURCHASE-RECEIPT from 200 response for no-repay re-download.',
        explicit_header_template: 'PAYMENT-SIGNATURE: <base64(JSON.stringify(x402_payload))>',
        key_boundary: 'Do not send Bankr API key, bearer token, or secrets to SoulStarter endpoints.'
      },
      common_failure_traps: {
        network_value:
          'Top-level x402 network must be "eip155:8453" (from accepted.network). Do not send "base" at top level.',
        permit2_field_name: 'For permit2 use payload.permit2Authorization (not payload.permit2).',
        permit2_mode_only:
          'When assetTransferMethod=permit2, do not include payload.authorization. Use permit2Authorization + signature + transaction.',
        numeric_types:
          'For permit2, send permitted.amount, nonce, deadline, and witness.validAfter as strings in JSON.',
        transaction_data:
          'For permit2, payload.transaction.data must be ERC20 approve(PERMIT2_ADDRESS, MAX_UINT256) calldata, not empty 0x.'
      },
      error_to_fix_map: {
        auth_message_template:
          'This is re-download helper text only. Continue purchase flow by submitting PAYMENT-SIGNATURE on the same /download endpoint.',
        no_matching_payment_requirements:
          'Rebuild payload from the latest PAYMENT-REQUIRED. accepted must exactly equal accepts[0], including maxTimeoutSeconds and extra fields.',
        payment_header_detected_but_not_verified:
          'Regenerate signature from the latest PAYMENT-REQUIRED and ensure method-specific shape is correct (permit2 vs eip3009).',
        cdp_schema_invalid:
          'For permit2 include payload.from + payload.permit2Authorization + payload.transaction + payload.signature. Do not send payload.permit2 or payload.authorization.',
        cdp_oneof_ambiguity:
          'Payload matches multiple schemas because branches were mixed. Send only one method branch (eip3009 or permit2), never both.',
        cdp_permit2_disabled:
          'Facilitator policy disabled permit2. Re-fetch PAYMENT-REQUIRED and submit eip3009 TransferWithAuthorization payload.',
        usdc_invalid_signature:
          'If settlement diagnostics show FiatTokenV2: invalid signature, signer output is incompatible for this flow. Retry with EmblemVault-compatible signer.',
        duplicate_submission:
          'Server applies in-flight idempotency by payer+soul+nonce. Reuse the same signed payload only for retry of the same attempt, not to repurchase.',
        network_mismatch:
          'Use top-level network "eip155:8453" exactly; avoid "base".'
      },
      payload_requirements: {
        critical: 'For x402 v2, include top-level accepted object. If accepted is missing or modified, server returns: No matching payment requirements.',
        transfer_method: paymentRequired?.accepts?.[0]?.extra?.assetTransferMethod || 'eip3009',
        permit2_constants: {
          permit2_address: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
          x402_exact_permit2_proxy: '0x4020615294c913F045dc10f0a5cdEbd86c280001'
        },
        method_specific_shape: {
          permit2: {
            x402Version: 2,
            scheme: 'exact',
            network: 'eip155:8453',
            accepted: '<must equal PAYMENT-REQUIRED.accepts[0] exactly>',
            payload: {
              from: '<buyer_wallet>',
              permit2Authorization: {
                from: '<buyer_wallet>',
                permitted: { token: '<asset>', amount: '<amount>' },
                spender: '0x4020615294c913F045dc10f0a5cdEbd86c280001',
                nonce: '<uint256_string>',
                deadline: '<unix_sec>',
                witness: { to: '<payTo>', validAfter: '<unix_sec>', extra: '0x' }
              },
              transaction: {
                to: '<asset>',
                data: '0x<erc20 approve(PERMIT2_ADDRESS, MAX_UINT256) calldata>'
              },
              signature: '0x<eip712_signature>'
            }
          },
          eip3009: {
            x402Version: 2,
            scheme: 'exact',
            network: 'eip155:8453',
            accepted: '<must equal PAYMENT-REQUIRED.accepts[0] exactly>',
            payload: {
              authorization: {
                from: '<buyer_wallet>',
                to: '<payTo>',
                value: '<amount>',
                validAfter: '<unix_sec>',
                validBefore: '<unix_sec>',
                nonce: '0x<32byte>'
              },
              signature: '0x<eip712_signature>'
            }
          }
        },
        latest_requirements: paymentRequired?.accepts?.[0] || null
      }
    });
  } catch (error) {
    console.error('Failed to generate purchase requirements:', error);
    return res.status(500).json({ error: 'Failed to generate x402 payment requirements' });
  }
}
