(function initPullMdWebMcp() {
  const modelContext = window.navigator && window.navigator.modelContext;
  if (!modelContext) return;

  function normalizeText(value) {
    return String(value || '').trim().toLowerCase();
  }

  async function fetchJson(url, options) {
    const response = await fetch(url, options);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(String(payload?.error || payload?.message || `Request failed: ${response.status}`));
    }
    return payload;
  }

  function filterAssets(assets, query) {
    const target = normalizeText(query);
    if (!target) return assets;
    return assets.filter((asset) => {
      const haystack = [
        asset?.id,
        asset?.name,
        asset?.description,
        asset?.asset_type,
        ...(Array.isArray(asset?.tags) ? asset.tags : [])
      ]
        .map((value) => normalizeText(value))
        .join(' ');
      return haystack.includes(target);
    });
  }

  const tools = [
    {
      name: 'pullmd.get_agent_entrypoints',
      title: 'PULL.md entrypoints',
      description: 'Return the main REST, MCP, and well-known discovery URLs for PULL.md.',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false
      },
      annotations: {
        readOnlyHint: true
      },
      execute: async () => ({
        name: 'PULL.md',
        entrypoints: {
          homepage: '/',
          api_catalog: '/.well-known/api-catalog',
          openapi: '/api/openapi.json',
          mcp_manifest: '/api/mcp/manifest',
          mcp_server_card: '/.well-known/mcp/server-card.json',
          agent_skills: '/.well-known/agent-skills/index.json',
          webmcp_markdown: '/WEBMCP.md',
          mcp_transport: '/mcp',
          public_catalog: '/api/assets'
        }
      })
    },
    {
      name: 'pullmd.list_assets',
      title: 'List PULL.md assets',
      description: 'List public PULL.md assets, optionally filtering by asset type or text query.',
      inputSchema: {
        type: 'object',
        properties: {
          asset_type: {
            type: 'string',
            description: 'Optional asset type filter such as soul or skill.'
          },
          query: {
            type: 'string',
            description: 'Optional text query matched against asset id, name, description, type, and tags.'
          }
        },
        additionalProperties: false
      },
      annotations: {
        readOnlyHint: true
      },
      execute: async ({ asset_type, query } = {}) => {
        const params = new URLSearchParams();
        if (normalizeText(asset_type)) {
          params.set('asset_type', String(asset_type).trim().toLowerCase());
        }
        const url = params.size ? `/api/assets?${params.toString()}` : '/api/assets';
        const payload = await fetchJson(url);
        const filtered = filterAssets(Array.isArray(payload?.assets) ? payload.assets : [], query);
        return {
          count: filtered.length,
          assets: filtered,
          meta: payload?.meta || {}
        };
      }
    },
    {
      name: 'pullmd.get_asset_details',
      title: 'Get PULL.md asset details',
      description: 'Return the richer PULL.md listing contract for a single asset id.',
      inputSchema: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            description: 'The asset id to inspect.'
          }
        },
        required: ['id'],
        additionalProperties: false
      },
      annotations: {
        readOnlyHint: true
      },
      execute: async ({ id } = {}) =>
        fetchJson('/api/ui/tool', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            name: 'get_asset_details',
            arguments: { id }
          })
        })
    }
  ];

  try {
    if (typeof modelContext.provideContext === 'function') {
      modelContext.provideContext({ tools });
      return;
    }

    if (typeof modelContext.registerTool === 'function') {
      for (const tool of tools) {
        modelContext.registerTool(tool);
      }
    }
  } catch (error) {
    console.warn('PULL.md WebMCP registration failed', error);
  }
})();
