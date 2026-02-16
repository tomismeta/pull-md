function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function code(value) {
  return `<code>${escapeHtml(value)}</code>`;
}

function list(items) {
  if (!Array.isArray(items) || items.length === 0) return '<p>None</p>';
  return `<ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`;
}

function keyValueRows(obj) {
  if (!obj || typeof obj !== 'object') return '<p>None</p>';
  const entries = Object.entries(obj);
  if (!entries.length) return '<p>None</p>';
  return `<div class="webmcp-kv-grid">${entries
    .map(([k, v]) => `<div><strong>${escapeHtml(k)}</strong><span>${escapeHtml(typeof v === 'string' ? v : JSON.stringify(v))}</span></div>`)
    .join('')}</div>`;
}

function section(title, bodyHtml) {
  return `<section class="webmcp-section"><h4>${escapeHtml(title)}</h4>${bodyHtml}</section>`;
}

function toolCard(tool) {
  return `<article class="workflow-card">
    <h3>${escapeHtml(tool.name || 'tool')}</h3>
    <p>${escapeHtml(tool.description || '')}</p>
    <p>${code(`${tool.method || 'GET'} ${tool.endpoint || ''}`)}</p>
    ${tool.deprecated ? '<p><strong>Deprecated.</strong></p>' : ''}
  </article>`;
}

function renderManifest(manifest) {
  const tools = Array.isArray(manifest.tools) ? manifest.tools : [];
  const auth = manifest.auth || {};
  const dl = manifest.download_contract || {};
  const caps = manifest.facilitator_capabilities || {};
  const errors = manifest.error_codes || {};
  return [
    section(
      'Overview',
      `<p><strong>${escapeHtml(manifest.name || 'SoulStarter')}</strong> — ${escapeHtml(manifest.description || '')}</p>
       <p>Canonical host: ${code(manifest.url || '')}</p>
       <p>Schema: ${code(manifest.schema_version || '')}</p>`
    ),
    section(
      'Auth Contract',
      `<p>Type: ${code(auth.type || '')} · Network: ${code(auth.network || '')} · Currency: ${code(auth.currency || '')}</p>
       <p>Strict agent mode value: ${code(auth.strict_agent_mode_value || 'agent')}</p>
       <p>Required payment header: ${code('PAYMENT-SIGNATURE')}</p>
       <p>Deprecated headers: ${Array.isArray(auth.deprecated_headers) ? auth.deprecated_headers.map(code).join(' ') : 'None'}</p>`
    ),
    section(
      'Facilitator Capabilities',
      keyValueRows(caps)
    ),
    section(
      'Canonical Download Flow',
      `<p>${escapeHtml(dl.canonical_purchase_flow || '')}</p>
       <p>${escapeHtml(dl.first_request || '')}</p>
       <p>${escapeHtml(dl.claim_request || '')}</p>
       <p>${escapeHtml(dl.redownload_request || '')}</p>`
    ),
    section(
      'Error Codes',
      keyValueRows(errors)
    ),
    section(
      'Tools',
      `<div class="workflow-grid">${tools.map(toolCard).join('')}</div>`
    ),
    section(
      'Raw Manifest',
      `<pre class="hero-code-block">${escapeHtml(JSON.stringify(manifest, null, 2))}</pre>`
    )
  ].join('');
}

async function loadManifest() {
  const container = document.getElementById('webmcpContractView');
  if (!container) return;
  try {
    const response = await fetch('/api/mcp/manifest', {
      method: 'GET',
      headers: { Accept: 'application/json' }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const manifest = await response.json();
    container.innerHTML = renderManifest(manifest);
  } catch (error) {
    container.innerHTML = `<p>Failed to load manifest: ${escapeHtml(error?.message || String(error))}</p>`;
  }
}

loadManifest();
