import { getSoul, loadSoulContent, soulIds } from '../../_lib/catalog.js';
import {
  buildAuthMessage,
  createPurchaseReceipt,
  getSellerAddress,
  setCors,
  verifyPurchaseReceipt,
  verifyWalletAuth
} from '../../_lib/payments.js';
import { applyInstructionResponse, createRequestContext, getX402HTTPServer } from '../../_lib/x402.js';

export default async function handler(req, res) {
  setCors(res, req.headers.origin);

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const soulId = req.query.id;
  const soul = getSoul(soulId);
  if (!soul) {
    return res.status(404).json({ error: 'Soul not found', available_souls: soulIds() });
  }

  const sellerAddress = getSellerAddress();
  if (!sellerAddress) {
    return res.status(500).json({ error: 'Server configuration error: SELLER_ADDRESS is required' });
  }

  // Re-download path: wallet re-auth + signed purchase receipt.
  const wallet = req.headers['x-wallet-address'];
  const authSignature = req.headers['x-auth-signature'];
  const authTimestamp = req.headers['x-auth-timestamp'];
  const receipt = req.headers['x-purchase-receipt'];
  const paymentSignature = req.headers['payment-signature'];

  if (wallet && authSignature && authTimestamp && receipt && !paymentSignature) {
    const authCheck = verifyWalletAuth({
      wallet,
      soulId,
      action: 'redownload',
      timestamp: authTimestamp,
      signature: authSignature
    });

    if (!authCheck.ok) {
      return res.status(401).json({ error: authCheck.error });
    }

    const receiptCheck = verifyPurchaseReceipt({
      receipt,
      wallet: authCheck.wallet,
      soulId
    });

    if (!receiptCheck.ok) {
      return res.status(401).json({ error: receiptCheck.error });
    }

    const content = await loadSoulContent(soulId);
    if (!content) {
      return res.status(500).json({ error: 'Soul unavailable' });
    }

    res.setHeader('Content-Type', 'text/markdown');
    res.setHeader('Content-Disposition', `attachment; filename="${soulId}-SOUL.md"`);
    res.setHeader(
      'PAYMENT-RESPONSE',
      Buffer.from(
        JSON.stringify({
          success: true,
          transaction: receiptCheck.transaction || 'prior-entitlement',
          network: 'eip155:8453',
          soulDelivered: soulId,
          entitlementSource: 'receipt'
        })
      ).toString('base64')
    );

    return res.status(200).send(content);
  }

  try {
    const httpServer = await getX402HTTPServer({ soulId, soul, sellerAddress });
    const context = createRequestContext(req);
    const result = await httpServer.processHTTPRequest(context);

    if (result.type === 'payment-error') {
      if (result.response?.body && typeof result.response.body === 'object') {
        if (!context.paymentHeader) {
          result.response.body.auth_message_template = buildAuthMessage({
            wallet: '0x<your-wallet>',
            soulId,
            action: 'redownload',
            timestamp: Date.now()
          });
          result.response.body.flow_hint =
            'No payment header was detected. Send PAYMENT-SIGNATURE (or PAYMENT/X-PAYMENT) with base64-encoded x402 payload for purchase.';
        } else {
          result.response.body.flow_hint =
            'Payment header was detected but could not be verified/settled. Regenerate PAYMENT-SIGNATURE from the latest PAYMENT-REQUIRED and retry.';
        }
      }
      return applyInstructionResponse(res, result.response);
    }

    if (result.type !== 'payment-verified') {
      return res.status(500).json({ error: 'Unexpected x402 processing state' });
    }

    const content = await loadSoulContent(soulId);
    if (!content) {
      return res.status(500).json({ error: 'Soul unavailable' });
    }

    const settlement = await httpServer.processSettlement(
      result.paymentPayload,
      result.paymentRequirements,
      result.declaredExtensions
    );

    if (!settlement.success) {
      return res.status(402).json({
        error: 'Settlement failed',
        reason: settlement.errorReason,
        message: settlement.errorMessage
      });
    }

    for (const [key, value] of Object.entries(settlement.headers || {})) {
      if (value != null) {
        res.setHeader(key, value);
      }
    }

    const receiptToken = settlement.payer
      ? createPurchaseReceipt({
          wallet: settlement.payer,
          soulId,
          transaction: settlement.transaction
        })
      : null;

    if (receiptToken) {
      res.setHeader('X-PURCHASE-RECEIPT', receiptToken);
    }

    res.setHeader('Content-Type', 'text/markdown');
    res.setHeader('Content-Disposition', `attachment; filename="${soulId}-SOUL.md"`);
    return res.status(200).send(content);
  } catch (error) {
    console.error('x402 processing failed:', error);
    return res.status(500).json({ error: 'Payment processing failed' });
  }
}
