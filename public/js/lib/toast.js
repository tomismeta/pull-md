(function attachSoulStarterToast(globalScope) {
  if (!globalScope || typeof globalScope !== 'object') return;

  function show({
    message,
    type = 'info',
    containerId = 'toastContainer',
    durationMs = 2800,
    removeDelayMs = 200
  } = {}) {
    const container = document.getElementById(String(containerId || 'toastContainer'));
    if (!container) return;
    const item = document.createElement('div');
    item.className = `toast toast-${String(type || 'info')}`;
    item.textContent = String(message || '');
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
