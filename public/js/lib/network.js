(function attachPullMdNetwork(globalScope) {
  if (!globalScope || typeof globalScope !== 'object') return;

  async function fetchWithTimeout(url, options = {}, timeoutMs = 45000) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), Number(timeoutMs || 45000));

    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(timeoutId);
      return response;
    } catch (error) {
      clearTimeout(timeoutId);
      if (error?.name === 'AbortError') throw new Error('Request timed out');
      throw error;
    }
  }

  async function readError(response) {
    try {
      const body = await response.json();
      return body?.error || body?.message || null;
    } catch (_) {
      return null;
    }
  }

  globalScope.PullMdNetwork = {
    fetchWithTimeout,
    readError
  };
})(typeof window !== 'undefined' ? window : globalThis);
