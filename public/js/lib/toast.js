(function attachSoulStarterToast(globalScope) {
  if (!globalScope || typeof globalScope !== 'object') return;
  const recentKeys = new Map();
  const DEDUPE_WINDOW_MS = 1800;

  function show({
    message,
    type = 'info',
    containerId = 'toastContainer',
    durationMs = 2800,
    removeDelayMs = 200,
    dedupe = true
  } = {}) {
    const container = document.getElementById(String(containerId || 'toastContainer'));
    if (!container) return;
    const normalizedMessage = String(message || '');
    const key = `${String(type || 'info')}::${normalizedMessage}`;
    const now = Date.now();
    if (dedupe) {
      const lastSeenAt = Number(recentKeys.get(key) || 0);
      if (now - lastSeenAt < DEDUPE_WINDOW_MS) return;
      recentKeys.set(key, now);
      setTimeout(() => {
        const current = Number(recentKeys.get(key) || 0);
        if (current === now) recentKeys.delete(key);
      }, DEDUPE_WINDOW_MS * 2);
    }
    const item = document.createElement('div');
    item.className = `toast toast-${String(type || 'info')}`;
    item.textContent = normalizedMessage;
    container.appendChild(item);
    requestAnimationFrame(() => item.classList.add('show'));
    setTimeout(() => {
      item.classList.remove('show');
      setTimeout(() => item.remove(), removeDelayMs);
    }, durationMs);
  }

  globalScope.SoulStarterToast = {
    show
  };
})(typeof window !== 'undefined' ? window : globalThis);
