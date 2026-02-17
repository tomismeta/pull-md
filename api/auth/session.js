import {
  setCors,
} from '../_lib/payments.js';
import { isAppError } from '../_lib/errors.js';
import { createBrowserRedownloadSession } from '../_lib/services/sessions.js';

export default async function handler(req, res) {
  setCors(res, req.headers.origin);

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const wallet = String(req.headers['x-wallet-address'] || '').trim();
  const signature = String(req.headers['x-auth-signature'] || '').trim();
  const timestamp = req.headers['x-auth-timestamp'];
  const clientMode = String(req.headers['x-client-mode'] || req.query?.client_mode || '')
    .trim()
    .toLowerCase();

  try {
    const session = await createBrowserRedownloadSession({
      wallet,
      signature,
      timestamp,
      clientMode,
      reqHost: req.headers.host
    });
    res.setHeader('Set-Cookie', session.setCookie);
    res.setHeader('X-REDOWNLOAD-SESSION', session.token);
    return res.status(200).json(session.payload);
  } catch (error) {
    if (isAppError(error)) {
      return res.status(error.status).json(error.payload);
    }
    return res.status(500).json({ error: error?.message || 'Failed to create session token' });
  }
}
