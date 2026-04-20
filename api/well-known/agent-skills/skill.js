import {
  cacheControl,
  setMarkdownDocumentHeaders,
  setPublicReadHeaders
} from '../../_lib/agent_ready.js';
import { getAgentSkillDefinition } from '../../_lib/agent_skills.js';

export default function handler(req, res) {
  const method = String(req.method || 'GET').toUpperCase();
  setPublicReadHeaders(res);
  res.setHeader('Cache-Control', cacheControl({ sMaxAge: 900, staleWhileRevalidate: 86400 }));

  if (method === 'OPTIONS') {
    res.setHeader('Allow', 'GET, HEAD, OPTIONS');
    return res.status(200).end();
  }

  if (!['GET', 'HEAD'].includes(method)) {
    res.setHeader('Allow', 'GET, HEAD, OPTIONS');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const skill = getAgentSkillDefinition(req.query?.name);
  if (!skill) {
    return res.status(404).json({
      error: 'Skill not found'
    });
  }

  setMarkdownDocumentHeaders(res, skill.content, { sMaxAge: 900, staleWhileRevalidate: 86400 });
  if (method === 'HEAD') {
    return res.status(200).end();
  }
  return res.status(200).send(skill.content);
}
