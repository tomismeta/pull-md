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

  const sellerAddress = getSellerAddress();
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
        step_4: 'On success, store X-PURCHASE-RECEIPT for future re-downloads'
      },
      security_rules: {
        never_share_bankr_key_with_soulstarter: true,
        note: 'Bankr API keys must stay inside the agent/Bankr runtime. SoulStarter only accepts signed x402 payment headers.'
      },
      header_format: {
        preferred: 'PAYMENT-SIGNATURE: <base64(JSON x402 payload)>',
        accepted_alternatives: ['PAYMENT: <base64(JSON x402 payload)>', 'X-PAYMENT: <base64(JSON x402 payload)>']
      },
      wallet_examples: {
        standard_wallet:
          'If assetTransferMethod=permit2, sign PermitWitnessTransferFrom and include permit2Authorization + transaction. If eip3009, sign TransferWithAuthorization.',
        bankr_wallet:
          'Agent orchestrates locally: call /agent/me, sign with /agent/sign, build base64 JSON payload, and send PAYMENT-SIGNATURE. Never send Bankr API key to SoulStarter.'
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
