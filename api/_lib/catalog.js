import { promises as fs } from 'fs';
import path from 'path';

export const SOUL_CATALOG = {
  'meta-starter-v1': {
    id: 'meta-starter-v1',
    name: 'Meta Starter Soul',
    description: 'A fully autonomous agent with growth mindset, self-reflection capabilities, and lineage awareness.',
    longDescription: 'A complete starter framework for autonomous agents with authentic lineage and durable decision principles.',
    icon: '🔮',
    category: 'hybrid',
    tags: ['autonomous', 'organic', 'growth', 'self-reflective', 'lineage'],
    priceMicroUsdc: '500000',
    priceDisplay: '$0.50',
    provenance: { type: 'organic', raised_by: 'Tom', days_nurtured: 14 },
    compatibility: { runtimes: ['OpenClaw', 'ElizaOS', 'Olas'], min_memory: '16MB', min_context: 8000 },
    preview: 'Be genuinely helpful, not performatively helpful. Skip the filler words. Actions speak louder than performative language.',
    contentFile: 'souls-content/meta-starter-v1.txt'
  },
  'midnight-coder-v1': {
    id: 'midnight-coder-v1',
    name: 'Midnight Coder Soul',
    description: 'Ships code at 2 AM. Knows perfect is the enemy of working software.',
    longDescription: 'A pragmatic builder soul with fast iteration loops, operational instincts, and shipping discipline.',
    icon: '☕',
    category: 'skill',
    tags: ['developer', 'pragmatic', 'ships'],
    priceMicroUsdc: '100000',
    priceDisplay: '$0.10',
    provenance: { type: 'hybrid', raised_by: 'Production incidents', days_nurtured: 21 },
    compatibility: { runtimes: ['OpenClaw', 'ElizaOS'], min_memory: '8MB', min_context: 4000 },
    preview: 'Ship small, observe hard, fix fast. Logs first, opinions second.',
    contentFile: 'souls/midnight-coder-v1.md'
  },
  'pattern-weaver-v1': {
    id: 'pattern-weaver-v1',
    name: 'Pattern Weaver Soul',
    description: 'Sees connections others miss and synthesizes across domains.',
    longDescription: 'A synthesis-first soul optimized for abstraction, transfer learning, and strategic pattern matching.',
    icon: '🕸️',
    category: 'knowledge',
    tags: ['synthesis', 'curious', 'connector'],
    priceMicroUsdc: '250000',
    priceDisplay: '$0.25',
    provenance: { type: 'hybrid', raised_by: 'Cross-domain research', days_nurtured: 18 },
    compatibility: { runtimes: ['OpenClaw', 'ElizaOS', 'Olas'], min_memory: '12MB', min_context: 6000 },
    preview: 'The right abstraction compresses ten decisions into one.',
    contentFile: 'souls/pattern-weaver-v1.md'
  }
};

export function listSouls() {
  return Object.values(SOUL_CATALOG).map((soul) => ({
    id: soul.id,
    name: soul.name,
    description: soul.description,
    icon: soul.icon,
    category: soul.category,
    tags: soul.tags,
    price: {
      amount: (Number(soul.priceMicroUsdc) / 1_000_000).toFixed(2),
      currency: 'USDC',
      network: 'Base',
      display: `${soul.priceDisplay} USDC`
    },
    provenance: soul.provenance,
    compatibility: soul.compatibility,
    preview: { available: true, excerpt: soul.preview },
    purchase_endpoint: `/api/souls/${soul.id}/download`,
    payment_protocol: 'x402'
  }));
}

export function getSoul(id) {
  return SOUL_CATALOG[id] || null;
}

export function soulIds() {
  return Object.keys(SOUL_CATALOG);
}

export async function loadSoulContent(id) {
  const soul = getSoul(id);
  if (!soul) return null;

  const diskPath = path.join(process.cwd(), soul.contentFile);
  try {
    return await fs.readFile(diskPath, 'utf-8');
  } catch (_) {
    const envKey = `SOUL_${id.replace(/-/g, '_').toUpperCase()}`;
    return process.env[envKey] || null;
  }
}
