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
  const bankrDebug = {
    flow: 'purchase_soul_bankr',
    stage: 'init',
    time: new Date().toISOString(),
    input: {
      soul_id: soulId || null,
      wallet_address_provided: Boolean(walletAddress),
      bankr_api_key_present: Boolean(bankrApiKey)
    },
    payment_required: null,
    bankr_me: null,
    sign: null,
    submit: null,
    mismatch: null
  };

  if (!soulId) {
    return res.status(400).json({ error: 'Missing required parameter: soul_id', bankr_debug: bankrDebug });
  }
  if (!bankrApiKey || typeof bankrApiKey !== 'string') {
    return res.status(400).json({
      error: 'Missing Bankr API key',
      expected: 'Provide bankr_api_key in body or X-BANKR-API-KEY header',
      bankr_debug: bankrDebug
    });
  }

  const soul = getSoul(soulId);
  if (!soul) {
    return res.status(404).json({ error: 'Soul not found', available_souls: soulIds(), bankr_debug: bankrDebug });
  }

  const sellerAddress = getSellerAddress();
  if (!sellerAddress) {
    return res.status(500).json({ error: 'Server configuration error: SELLER_ADDRESS is required', bankr_debug: bankrDebug });
  }

  try {
    bankrDebug.stage = 'fetch_payment_required';
    const paymentRequired = await fetchPaymentRequired({ req, soulId, soul, sellerAddress });
    const accepted = paymentRequired?.accepts?.[0];
    bankrDebug.payment_required = summarizePaymentRequired(paymentRequired);

    if (!accepted) {
      return res.status(500).json({ error: 'PAYMENT-REQUIRED missing accepts[0]', bankr_debug: bankrDebug });
    }

    bankrDebug.stage = 'bankr_me';
    const meResult = await fetchBankrWalletAddress(bankrApiKey);
    bankrDebug.bankr_me = {
      ok: meResult.ok,
      status: meResult.status,
      body_summary: summarizeObject(meResult.body),
      evm_wallet: meResult.wallet || null
    };
    if (!meResult.ok) {
      return res.status(502).json({
        error: 'Bankr wallet lookup failed. Ensure API key has Agent API access.',
        bankr_debug: bankrDebug
      });
    }

    const bankrWallet = meResult.wallet;
    if (!bankrWallet) {
      return res.status(502).json({
        error: 'Bankr wallet lookup did not return an EVM wallet',
        bankr_debug: bankrDebug
      });
    }

    const payer = walletAddress || bankrWallet;
    if (!isAddress(payer)) {
      bankrDebug.mismatch = { type: 'wallet_format', payer };
      return res.status(400).json({ error: 'Invalid wallet address format', bankr_debug: bankrDebug });
    }
    if (walletAddress && walletAddress.toLowerCase() !== bankrWallet.toLowerCase()) {
      bankrDebug.mismatch = {
        type: 'wallet_mismatch',
        wallet_address: walletAddress,
        bankr_wallet: bankrWallet
      };
      return res.status(400).json({
        error: 'wallet_address does not match Bankr account wallet',
        wallet_address: walletAddress,
        bankr_wallet: bankrWallet,
        bankr_debug: bankrDebug
      });
    }

    bankrDebug.stage = 'build_typed_data';
    const typedData = buildTypedData({ paymentRequired, accepted, payer });
    bankrDebug.sign = {
      chainId: typedData.domain?.chainId ?? null,
      verifyingContract: typedData.domain?.verifyingContract ?? null,
      domainName: typedData.domain?.name ?? null,
      domainVersion: typedData.domain?.version ?? null,
      primaryType: typedData.primaryType,
      authorization: summarizeAuthorization(typedData.message)
    };

    bankrDebug.stage = 'bankr_sign';
    const signResult = await signTypedDataWithBankr({ bankrApiKey, typedData });
    bankrDebug.sign = {
      ...bankrDebug.sign,
      ok: signResult.ok,
      status: signResult.status,
      response_summary: summarizeObject(signResult.body),
      signature_length: signResult.signature ? signResult.signature.length : null
    };
    if (!signResult.ok || !signResult.signature) {
      return res.status(502).json({
        error: 'Bankr typed-data signing failed',
        bankr_debug: bankrDebug
      });
    }
    const signature = signResult.signature;

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
    bankrDebug.stage = 'submit_payment';
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
    bankrDebug.submit = {
      status: purchaseResponse.status,
      content_type: contentType,
      has_payment_response_header: Boolean(paymentResponseHeader),
      has_purchase_receipt: Boolean(purchaseReceipt)
    };

    if (!purchaseResponse.ok) {
      let body = null;
      try {
        body = JSON.parse(responseText);
      } catch (_) {
        body = { raw: responseText };
      }
      bankrDebug.submit.response_summary = summarizeObject(body);

      return res.status(purchaseResponse.status).json({
        error: 'Bankr signed payment was not accepted',
        soul_id: soulId,
        bankr_wallet: bankrWallet,
        upstream_status: purchaseResponse.status,
        upstream_body: body,
        bankr_debug: bankrDebug
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
      soul_markdown: responseText,
      bankr_debug: { ...bankrDebug, stage: 'complete' }
    });
  } catch (error) {
    console.error('Bankr purchase flow failed:', error);
    bankrDebug.stage = 'exception';
    return res.status(500).json({
      error: 'Bankr purchase flow failed',
      detail: error instanceof Error ? error.message : String(error),
      bankr_debug: bankrDebug
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

  const body = await response.json().catch(() => ({}));
  const wallets = Array.isArray(body?.wallets) ? body.wallets : [];
  const evmWallet = wallets.find((item) => item && item.chain === 'evm' && isAddress(item.address));
  return {
    ok: response.ok,
    status: response.status,
    body,
    wallet: evmWallet?.address || null
  };
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
  const signature = body?.signature || body?.data?.signature;
  return {
    ok: response.ok && isHexSignature(signature),
    status: response.status,
    body,
    signature: isHexSignature(signature) ? signature : null
  };
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

function summarizePaymentRequired(paymentRequired) {
  const accepted = paymentRequired?.accepts?.[0];
  if (!accepted) return null;
  return {
    x402Version: paymentRequired?.x402Version ?? null,
    scheme: accepted.scheme ?? null,
    network: accepted.network ?? null,
    amount: accepted.amount ?? null,
    asset: accepted.asset ?? null,
    payTo: accepted.payTo ?? null,
    maxTimeoutSeconds: accepted.maxTimeoutSeconds ?? null
  };
}

function summarizeAuthorization(auth) {
  if (!auth || typeof auth !== 'object') return null;
  return {
    from: auth.from ?? null,
    to: auth.to ?? null,
    value: auth.value ?? null,
    validAfter: auth.validAfter ?? null,
    validBefore: auth.validBefore ?? null,
    nonce_bytes32: typeof auth.nonce === 'string' && /^0x[0-9a-fA-F]{64}$/.test(auth.nonce)
  };
}

function summarizeObject(value) {
  if (!value || typeof value !== 'object') return value ?? null;
  const summary = {};
  const keys = ['error', 'message', 'detail', 'code', 'status', 'reason', 'type', 'ok'];
  for (const key of keys) {
    if (value[key] != null) summary[key] = value[key];
  }
  if (Array.isArray(value.wallets)) {
    summary.wallets_count = value.wallets.length;
    summary.wallet_chains = value.wallets.map((item) => item?.chain).filter(Boolean);
  }
  if (value.data && typeof value.data === 'object') {
    summary.data_keys = Object.keys(value.data).slice(0, 10);
    if (typeof value.data.signature === 'string') {
      summary.data_signature_length = value.data.signature.length;
    }
  }
  if (typeof value.signature === 'string') {
    summary.signature_length = value.signature.length;
  }
  return Object.keys(summary).length > 0 ? summary : { keys: Object.keys(value).slice(0, 12) };
}
