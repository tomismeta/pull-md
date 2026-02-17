import { isAppError } from '../../_lib/errors.js';
import { setCors } from '../../_lib/payments.js';
import { buildMcpSoulDetailsResponse, resolveSoulDetails } from '../../_lib/services/souls.js';

export default async function handler(req, res) {
  setCors(res, req.headers.origin);

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const details = await resolveSoulDetails(req.query?.id);
    return res.status(200).json(buildMcpSoulDetailsResponse(details));
  } catch (error) {
    if (isAppError(error)) {
      return res.status(error.status).json(error.payload);
    }
    return res.status(500).json({ error: 'Unable to load soul details' });
  }
}
