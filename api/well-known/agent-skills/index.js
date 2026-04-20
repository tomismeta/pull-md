import { cacheControl, setPublicReadHeaders } from '../../_lib/agent_ready.js';
import { resolveBaseUrl } from '../../_lib/discovery.js';
import { listAgentSkills } from '../../_lib/agent_skills.js';

function buildAgentSkillsIndex(baseUrl) {
  return {
    $schema: 'https://schemas.agentskills.io/discovery/0.2.0/schema.json',
    skills: listAgentSkills(baseUrl)
  };
}

export default function handler(req, res) {
  const method = String(req.method || 'GET').toUpperCase();
  setPublicReadHeaders(res);
  res.setHeader('Cache-Control', cacheControl({ sMaxAge: 900, staleWhileRevalidate: 86400 }));
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  if (method === 'OPTIONS') {
    res.setHeader('Allow', 'GET, HEAD, OPTIONS');
    return res.status(200).end();
  }

  if (!['GET', 'HEAD'].includes(method)) {
    res.setHeader('Allow', 'GET, HEAD, OPTIONS');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const body = buildAgentSkillsIndex(resolveBaseUrl(req.headers || {}));
  if (method === 'HEAD') {
    return res.status(200).end();
  }
  return res.status(200).json(body);
}
