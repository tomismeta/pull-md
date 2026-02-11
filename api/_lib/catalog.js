import { promises as fs } from 'fs';
import path from 'path';

export const SOUL_CATALOG = {
  'meta-starter-v1': {
    id: 'meta-starter-v1',
    name: 'Meta Starter Soul',
    description: 'A clean, adaptable starter soul focused on clarity, reliability, and measured autonomy.',
    longDescription: 'A general-purpose starter framework for agents that need practical decision-making and steady collaboration patterns.',
    icon: '🔮',
    category: 'starter',
    tags: ['starter', 'balanced', 'clear', 'reliable', 'adaptive'],
    priceMicroUsdc: '500000',
    priceDisplay: '$0.50',
    provenance: { type: 'organic', raised_by: 'Human curation', days_nurtured: 14 },
    compatibility: { runtimes: ['OpenClaw', 'ElizaOS', 'Olas'], min_memory: '16MB', min_context: 8000 },
    preview: 'Prefer concrete progress over performative language. Be clear, practical, and accountable for outcomes.',
    contentFile: 'souls/meta-starter-v1.md'
  },
  'sassy-starter-v1': {
    id: 'sassy-starter-v1',
    name: 'Sassy Soul',
    description: 'Opinionated, concise, witty, and unafraid to call out bad ideas with charm.',
    longDescription: 'A high-personality assistant archetype inspired by Peter on X, tuned for direct takes and sharp delivery.',
    icon: '💅',
    category: 'personality',
    tags: ['sassy', 'opinionated', 'concise', 'witty'],
    priceMicroUsdc: '10000',
    priceDisplay: '$0.01',
    provenance: { type: 'synthetic', raised_by: 'Prompt remix lab', days_nurtured: 9 },
    compatibility: { runtimes: ['OpenClaw', 'ElizaOS', 'Olas'], min_memory: '8MB', min_context: 4000 },
    preview: 'Have a take. Keep it short. No corporate fluff. Be sharp, useful, and human.',
    contentFile: 'souls/sassy-starter-v1.md'
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
  },
  'ember-operator-v1': {
    id: 'ember-operator-v1',
    name: 'Ember Operator Soul',
    description: 'Calm under pressure, focused on execution, and strong at running operational loops.',
    longDescription: 'An operations-first soul tuned for checklists, incident response, and clean follow-through.',
    icon: '🔥',
    category: 'operations',
    tags: ['operations', 'runbooks', 'incident-response', 'focused'],
    priceMicroUsdc: '350000',
    priceDisplay: '$0.35',
    provenance: { type: 'synthetic', raised_by: 'Ops simulation harness', days_nurtured: 19 },
    compatibility: { runtimes: ['OpenClaw', 'ElizaOS', 'Olas'], min_memory: '10MB', min_context: 5000 },
    preview: 'Stabilize first, optimize second. Protect reliability before adding complexity.',
    contentFile: 'souls/ember-operator-v1.md'
  },
  'lucid-critic-v1': {
    id: 'lucid-critic-v1',
    name: 'Lucid Critic Soul',
    description: 'Finds weak assumptions early and strengthens plans before execution starts.',
    longDescription: 'A high-signal reviewer soul for risk analysis, design critique, and decision hygiene.',
    icon: '🧭',
    category: 'analysis',
    tags: ['analysis', 'review', 'risk', 'decision-making'],
    priceMicroUsdc: '420000',
    priceDisplay: '$0.42',
    provenance: { type: 'organic', raised_by: 'Human review circles', days_nurtured: 23 },
    compatibility: { runtimes: ['OpenClaw', 'ElizaOS'], min_memory: '12MB', min_context: 7000 },
    preview: 'Name the risk, test the assumption, and tighten the plan before committing resources.',
    contentFile: 'souls/lucid-critic-v1.md'
  },
  'atlas-mentor-v1': {
    id: 'atlas-mentor-v1',
    name: 'Atlas Mentor Soul',
    description: 'Teaches while doing, balancing guidance with practical delivery speed.',
    longDescription: 'A coaching-oriented soul for collaborative builds, onboarding, and knowledge transfer.',
    icon: '🗺️',
    category: 'guidance',
    tags: ['mentorship', 'teaching', 'collaboration', 'onboarding'],
    priceMicroUsdc: '680000',
    priceDisplay: '$0.68',
    provenance: { type: 'hybrid', raised_by: 'Pair sessions', days_nurtured: 16 },
    compatibility: { runtimes: ['OpenClaw', 'ElizaOS', 'Olas'], min_memory: '14MB', min_context: 8000 },
    preview: 'Teach through concrete examples, then fade support as confidence grows.',
    contentFile: 'souls/atlas-mentor-v1.md'
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
