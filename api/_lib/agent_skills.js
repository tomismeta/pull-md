import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const SKILL_DEFINITIONS = [
  {
    name: 'discover-catalog',
    description: 'Discover the PULL.md catalog and choose the right REST or MCP entrypoint for the task.'
  },
  {
    name: 'purchase-asset',
    description: 'Buy or re-download a PULL.md markdown asset through the canonical x402 download flow.'
  },
  {
    name: 'publish-asset',
    description: 'Publish a markdown asset to PULL.md using the MCP creator flow and SIWE wallet proof.'
  }
];

function skillFilePath(name) {
  return path.join(process.cwd(), 'agent-skills', name, 'SKILL.md');
}

function readSkillFileBuffer(name) {
  return fs.readFileSync(skillFilePath(name));
}

export function getAgentSkillDefinition(name) {
  const target = String(name || '').trim().toLowerCase();
  if (!target) return null;
  const definition = SKILL_DEFINITIONS.find((skill) => skill.name === target);
  if (!definition) return null;
  const rawBytes = readSkillFileBuffer(definition.name);
  return {
    ...definition,
    type: 'skill-md',
    content: rawBytes.toString('utf8'),
    digest: `sha256:${crypto.createHash('sha256').update(rawBytes).digest('hex')}`
  };
}

export function listAgentSkills(baseUrl) {
  return SKILL_DEFINITIONS.map((definition) => {
    const resolved = getAgentSkillDefinition(definition.name);
    return {
      name: definition.name,
      type: 'skill-md',
      description: definition.description,
      url: `${baseUrl}/.well-known/agent-skills/${definition.name}/SKILL.md`,
      digest: resolved.digest
    };
  });
}
