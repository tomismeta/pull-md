import { getSoulResolved, listSoulsResolved, soulIdsResolved } from '../../_lib/catalog.js';
import { buildSiweAuthMessage, getSellerAddress, setCors } from '../../_lib/payments.js';

export default async function handler(req, res) {
  setCors(res, req.headers.origin);

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { id } = req.query;
  if (!id) {
    return res.status(400).json({ error: 'Missing required parameter: id' });
  }

  const soul = await getSoulResolved(id);
  if (!soul) {
    return res.status(404).json({ error: 'Soul not found', available_souls: await soulIdsResolved() });
  }

  const summary = (await listSoulsResolved()).find((item) => item.id === id);
  const sellerAddress = soul.sellerAddress || getSellerAddress();

  return res.status(200).json({
    soul: {
      ...summary,
      long_description: soul.longDescription,
      files: ['SOUL.md'],
      purchase_endpoint: `/api/souls/${id}/download`,
      payment_protocol: 'x402',
      auth_headers: {
        purchase: ['PAYMENT-SIGNATURE'],
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
        note: 'Use accepted exactly as returned in PAYMENT-REQUIRED.accepts[0]. Keep scheme/network at top level.'
      },
      auth_message_examples: {
        redownload: buildSiweAuthMessage({
          wallet: '0x<your-wallet>',
          soulId: id,
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
  });
}
