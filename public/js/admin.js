const API_BASE = '/api/mcp/tools/creator_marketplace';
const TOKEN_KEY = 'soulstarter_admin_token';

function showToast(message, type = 'info') {
  const container = document.getElementById('toastContainer');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('show'));
  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 200);
  }, 2800);
}

function getToken() {
  return localStorage.getItem(TOKEN_KEY) || '';
}

function setStatus(text) {
  const el = document.getElementById('tokenStatus');
  if (el) el.textContent = text;
}

function renderEmpty(containerId, text) {
  const el = document.getElementById(containerId);
  if (!el) return;
  el.innerHTML = `<p class="admin-empty">${text}</p>`;
}

async function apiCall(action, { method = 'GET', body } = {}) {
  const token = getToken();
  if (!token) {
    throw new Error('Admin token is required');
  }
  const url = `${API_BASE}?action=${encodeURIComponent(action)}`;
  const response = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-ADMIN-TOKEN': token
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || `Request failed (${response.status})`);
  }
  return payload;
}

function formatDate(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return date.toLocaleString();
}

function draftCardActions(item) {
  const wallet = item.wallet_address;
  const draftId = item.draft_id;
  return `
    <div class="admin-card-actions">
      <button class="btn btn-ghost" data-action="approve" data-wallet="${wallet}" data-draft="${draftId}">approve</button>
      <button class="btn btn-ghost" data-action="reject" data-wallet="${wallet}" data-draft="${draftId}">reject</button>
      <button class="btn btn-primary" data-action="publish" data-wallet="${wallet}" data-draft="${draftId}">publish</button>
    </div>
  `;
}

function renderQueue(items) {
  const container = document.getElementById('queueContainer');
  if (!container) return;
  if (!Array.isArray(items) || items.length === 0) {
    renderEmpty('queueContainer', 'No drafts waiting review.');
    return;
  }

  container.innerHTML = items
    .map((item) => {
      const listing = item.normalized?.listing || {};
      return `
        <article class="admin-card">
          <div class="admin-card-row">
            <h4>${listing.name || item.draft_id}</h4>
            <span class="badge badge-hybrid">${item.status || 'unknown'}</span>
          </div>
          <p class="admin-line">Soul ID: <code>${listing.soul_id || '-'}</code></p>
          <p class="admin-line">Creator: <code>${item.wallet_address || '-'}</code></p>
          <p class="admin-line">Price: <code>$${Number(listing.price_usdc || 0).toFixed(2)}</code></p>
          <p class="admin-line">Submitted: <code>${formatDate(item.moderation?.submitted_at)}</code></p>
          ${draftCardActions(item)}
        </article>
      `;
    })
    .join('');
}

function renderPublished(items) {
  const container = document.getElementById('publishedContainer');
  if (!container) return;
  if (!Array.isArray(items) || items.length === 0) {
    renderEmpty('publishedContainer', 'No published listings yet.');
    return;
  }

  container.innerHTML = items
    .map((item) => {
      const listing = item.normalized?.listing || {};
      return `
        <article class="admin-card">
          <div class="admin-card-row">
            <h4>${listing.name || item.draft_id}</h4>
            <span class="badge badge-organic">published</span>
          </div>
          <p class="admin-line">Soul ID: <code>${listing.soul_id || '-'}</code></p>
          <p class="admin-line">Creator: <code>${item.wallet_address || '-'}</code></p>
          <p class="admin-line">Published: <code>${formatDate(item.published_at || item.updated_at)}</code></p>
        </article>
      `;
    })
    .join('');
}

async function loadQueue() {
  try {
    const data = await apiCall('list_review_queue');
    renderQueue(data.queue || []);
  } catch (error) {
    renderEmpty('queueContainer', `Queue load failed: ${error.message}`);
  }
}

async function loadPublished() {
  try {
    const data = await apiCall('list_published_listings');
    renderPublished(data.listings || []);
  } catch (error) {
    renderEmpty('publishedContainer', `Published load failed: ${error.message}`);
  }
}

async function reviewDecision(walletAddress, draftId, decision) {
  await apiCall('review_listing_submission', {
    method: 'POST',
    body: {
      wallet_address: walletAddress,
      draft_id: draftId,
      decision,
      reviewer: 'admin-ui'
    }
  });
}

async function publishDraft(walletAddress, draftId) {
  await apiCall('publish_listing', {
    method: 'POST',
    body: {
      wallet_address: walletAddress,
      draft_id: draftId,
      reviewer: 'admin-ui'
    }
  });
}

function bindEvents() {
  const saveBtn = document.getElementById('saveTokenBtn');
  const clearBtn = document.getElementById('clearTokenBtn');
  const tokenInput = document.getElementById('adminTokenInput');
  const refreshQueueBtn = document.getElementById('refreshQueueBtn');
  const refreshPublishedBtn = document.getElementById('refreshPublishedBtn');

  if (tokenInput) tokenInput.value = getToken();
  setStatus(getToken() ? 'Token saved locally for this browser.' : 'No token saved.');

  saveBtn?.addEventListener('click', async () => {
    const value = (tokenInput?.value || '').trim();
    if (!value) {
      showToast('Enter a token first', 'warning');
      return;
    }
    localStorage.setItem(TOKEN_KEY, value);
    setStatus('Token saved locally for this browser.');
    showToast('Admin token saved', 'success');
    await Promise.all([loadQueue(), loadPublished()]);
  });

  clearBtn?.addEventListener('click', () => {
    localStorage.removeItem(TOKEN_KEY);
    if (tokenInput) tokenInput.value = '';
    setStatus('No token saved.');
    renderEmpty('queueContainer', 'Admin token required.');
    renderEmpty('publishedContainer', 'Admin token required.');
    showToast('Admin token cleared', 'info');
  });

  refreshQueueBtn?.addEventListener('click', loadQueue);
  refreshPublishedBtn?.addEventListener('click', loadPublished);

  document.addEventListener('click', async (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const action = target.getAttribute('data-action');
    if (!action) return;
    const wallet = target.getAttribute('data-wallet');
    const draft = target.getAttribute('data-draft');
    if (!wallet || !draft) return;
    target.setAttribute('disabled', 'true');
    try {
      if (action === 'approve' || action === 'reject') {
        await reviewDecision(wallet, draft, action);
        showToast(`Draft ${action}d`, 'success');
      } else if (action === 'publish') {
        await publishDraft(wallet, draft);
        showToast('Draft published', 'success');
      }
      await Promise.all([loadQueue(), loadPublished()]);
    } catch (error) {
      showToast(error.message, 'error');
    } finally {
      target.removeAttribute('disabled');
    }
  });
}

async function init() {
  bindEvents();
  if (getToken()) {
    await Promise.all([loadQueue(), loadPublished()]);
  } else {
    renderEmpty('queueContainer', 'Admin token required.');
    renderEmpty('publishedContainer', 'Admin token required.');
  }
}

init();
