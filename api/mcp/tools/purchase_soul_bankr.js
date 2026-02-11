import crypto from 'crypto';
import { getSoul, soulIds } from '../../_lib/catalog.js';
import { getSellerAddress, setCors } from '../../_lib/payments.js';
import { createRequestContext, getX402HTTPServer } from '../../_lib/x402.js';

const BANKR_API_BASE = 'https://api.bankr.bot';

export default async function handler(req, res) {
  setCors(res, req.headers.origin);

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { soul_id: soulId, wallet_address: walletAddress, bankr_api_key: bodyApiKey } = req.body || {};
  const bankrApiKey = req.headers['x-bankr-api-key'] || bodyApiKey || process.env.BANKR_API_KEY;

  if (!soulId) {
    return res.status(400).json({ error: 'Missing required parameter: soul_id' });
  }
  if (!bankrApiKey || typeof bankrApiKey !== 'string') {
    return res.status(400).json({
      error: 'Missing Bankr API key',
      expected: 'Provide bankr_api_key in body or X-BANKR-API-KEY header'
    });
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
    const paymentRequired = await fetchPaymentRequired({ req, soulId, soul, sellerAddress });
    const accepted = paymentRequired?.accepts?.[0];
    if (!accepted) {
      return res.status(500).json({ error: 'PAYMENT-REQUIRED missing accepts[0]' });
    }

    const bankrWallet = await fetchBankrWalletAddress(bankrApiKey);
    if (!bankrWallet) {
      return res.status(502).json({ error: 'Bankr wallet lookup failed. Ensure API key has Agent API access.' });
    }

    const payer = walletAddress || bankrWallet;
    if (!isAddress(payer)) {
      return res.status(400).json({ error: 'Invalid wallet address format' });
    }
    if (walletAddress && walletAddress.toLowerCase() !== bankrWallet.toLowerCase()) {
      return res.status(400).json({
        error: 'wallet_address does not match Bankr account wallet',
        wallet_address: walletAddress,
        bankr_wallet: bankrWallet
      });
    }

    const typedData = buildTypedData({ paymentRequired, accepted, payer });
    const signature = await signTypedDataWithBankr({ bankrApiKey, typedData });

    const paymentPayload = {
      x402Version: paymentRequired?.x402Version ?? 2,
      scheme: accepted.scheme,
      network: accepted.network,
      accepted,
      payload: {
        authorization: typedData.message,
        signature
      }
    };
    const encodedPayment = Buffer.from(JSON.stringify(paymentPayload)).toString('base64');

    const baseUrl = requestBaseUrl(req);
    const downloadUrl = `${baseUrl}/api/souls/${encodeURIComponent(soulId)}/download`;
    const purchaseResponse = await fetch(downloadUrl, {
      method: 'GET',
      headers: {
        Accept: 'application/json, text/markdown',
        'PAYMENT-SIGNATURE': encodedPayment
      }
    });

    const paymentResponseHeader = purchaseResponse.headers.get('payment-response');
    const purchaseReceipt = purchaseResponse.headers.get('x-purchase-receipt');
    const contentType = purchaseResponse.headers.get('content-type') || '';
    const responseText = await purchaseResponse.text();

    if (!purchaseResponse.ok) {
      let body = null;
      try {
        body = JSON.parse(responseText);
      } catch (_) {
        body = { raw: responseText };
      }

      return res.status(purchaseResponse.status).json({
        error: 'Bankr signed payment was not accepted',
        soul_id: soulId,
        bankr_wallet: bankrWallet,
        upstream_status: purchaseResponse.status,
        upstream_body: body
      });
    }

    let paymentResponse = null;
    if (paymentResponseHeader) {
      try {
        paymentResponse = JSON.parse(Buffer.from(paymentResponseHeader, 'base64').toString('utf-8'));
      } catch (_) {
        paymentResponse = null;
      }
    }

    return res.status(200).json({
      success: true,
      soul_id: soulId,
      wallet_address: payer.toLowerCase(),
      purchase_receipt: purchaseReceipt || null,
      payment_response: paymentResponse,
      content_type: contentType,
      soul_markdown: responseText
    });
  } catch (error) {
    console.error('Bankr purchase flow failed:', error);
    return res.status(500).json({
      error: 'Bankr purchase flow failed',
      detail: error instanceof Error ? error.message : String(error)
    });
  }
}

async function fetchPaymentRequired({ req, soulId, soul, sellerAddress }) {
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
  const header = result.response?.headers?.['PAYMENT-REQUIRED'] || result.response?.headers?.['payment-required'];
  if (!header) return null;
  return JSON.parse(Buffer.from(header, 'base64').toString('utf-8'));
}

async function fetchBankrWalletAddress(apiKey) {
  const response = await fetch(`${BANKR_API_BASE}/agent/me`, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      'X-API-Key': apiKey
    }
  });

  if (!response.ok) {
    throw new Error(`Bankr /agent/me failed with status ${response.status}`);
  }

  const body = await response.json();
  const wallets = Array.isArray(body?.wallets) ? body.wallets : [];
  const evmWallet = wallets.find((item) => item && item.chain === 'evm' && isAddress(item.address));
  return evmWallet?.address || null;
}

async function signTypedDataWithBankr({ bankrApiKey, typedData }) {
  const response = await fetch(`${BANKR_API_BASE}/agent/sign`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'X-API-Key': bankrApiKey
    },
    body: JSON.stringify({
      signatureType: 'eth_signTypedData_v4',
      typedData
    })
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`Bankr /agent/sign failed with status ${response.status}`);
  }

  const signature = body?.signature || body?.data?.signature;
  if (!isHexSignature(signature)) {
    throw new Error('Bankr /agent/sign response did not include a valid signature');
  }
  return signature;
}

function buildTypedData({ paymentRequired, accepted, payer }) {
  const chainId = parseChainId(accepted.network);
  if (!chainId) {
    throw new Error(`Unsupported network format: ${accepted.network}`);
  }

  const now = Math.floor(Date.now() / 1000);
  const authorization = {
    from: payer,
    to: accepted.payTo,
    value: accepted.amount,
    validAfter: String(now - 600),
    validBefore: String(now + Number(accepted.maxTimeoutSeconds || 300)),
    nonce: `0x${crypto.randomBytes(32).toString('hex')}`
  };

  return {
    domain: {
      name: accepted?.extra?.name || 'USD Coin',
      version: accepted?.extra?.version || '2',
      chainId,
      verifyingContract: accepted.asset
    },
    types: {
      TransferWithAuthorization: [
        { name: 'from', type: 'address' },
        { name: 'to', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'validAfter', type: 'uint256' },
        { name: 'validBefore', type: 'uint256' },
        { name: 'nonce', type: 'bytes32' }
      ]
    },
    primaryType: 'TransferWithAuthorization',
    message: authorization,
    x402Version: paymentRequired?.x402Version ?? 2
  };
}

function requestBaseUrl(req) {
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers.host || 'soulstarter.vercel.app';
  return `${proto}://${host}`;
}

function parseChainId(network) {
  if (typeof network !== 'string') return null;
  const parts = network.split(':');
  if (parts.length < 2) return null;
  const value = Number(parts[1]);
  return Number.isFinite(value) ? value : null;
}

function isAddress(value) {
  return typeof value === 'string' && /^0x[a-fA-F0-9]{40}$/.test(value);
}

function isHexSignature(value) {
  return typeof value === 'string' && /^0x[a-fA-F0-9]+$/.test(value) && value.length >= 132;
}
