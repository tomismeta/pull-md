import { setCors } from './_lib/payments.js';

export default function handler(req, res) {
  setCors(res, req.headers.origin);

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  return res.status(200).json({
    walletConnectProjectId: process.env.WALLETCONNECT_PROJECT_ID || null,
    network: 'eip155:8453',
    emblemAppId: process.env.EMBLEM_APP_ID || ''
  });
}
