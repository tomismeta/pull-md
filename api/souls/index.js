import { isAppError } from '../_lib/errors.js';
import { setCors } from '../_lib/payments.js';
import { buildPublicSoulsResponse, listSoulsCatalog } from '../_lib/services/souls.js';

export default async function handler(req, res) {
  setCors(res, req.headers.origin);

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const souls = await listSoulsCatalog({ category: req.query?.category });
    return res.status(200).json(buildPublicSoulsResponse(souls));
  } catch (error) {
    if (isAppError(error)) {
      return res.status(error.status).json(error.payload);
    }
    return res.status(500).json({
      error: 'Unable to load soul catalog',
      details: error?.message || 'unknown_error'
    });
  }
}
