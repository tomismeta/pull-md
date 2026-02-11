import { getSoul, listSouls, soulIds } from '../../_lib/catalog.js';
import { buildAuthMessage, getSellerAddress, setCors } from '../../_lib/payments.js';

export default function handler(req, res) {
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

  const soul = getSoul(id);
  if (!soul) {
    return res.status(404).json({ error: 'Soul not found', available_souls: soulIds() });
  }

  const summary = listSouls().find((item) => item.id === id);
  const sellerAddress = getSellerAddress();

  return res.status(200).json({
    soul: {
      ...summary,
      long_description: soul.longDescription,
      files: ['SOUL.md', 'AGENTS.md', 'HEARTBEAT.md', 'TOOLS.md.template'],
      purchase_endpoint: `/api/souls/${id}/download`,
      payment_protocol: 'x402',
      auth_headers: {
        purchase: ['PAYMENT-SIGNATURE'],
        redownload: ['X-WALLET-ADDRESS', 'X-AUTH-SIGNATURE', 'X-AUTH-TIMESTAMP', 'X-PURCHASE-RECEIPT']
      },
      auth_message_examples: {
        redownload: buildAuthMessage({
          wallet: '0x<your-wallet>',
          soulId: id,
          action: 'redownload',
          timestamp: Date.now()
        })
      },
      seller_address: sellerAddress
    },
    meta: {
      agent_friendly: true,
      purchase_flow: 'x402',
      documentation: '/api/mcp/manifest'
    }
  });
}
