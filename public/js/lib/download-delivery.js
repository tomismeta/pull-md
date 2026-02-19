(function attachSoulStarterDownloadDelivery(globalScope) {
  if (!globalScope || typeof globalScope !== 'object') return;

  function triggerMarkdownDownload(content, soulId, fileName = 'ASSET.md') {
    const blob = new Blob([content], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    const normalized = String(fileName || 'ASSET.md').trim() || 'ASSET.md';
    anchor.download = `${soulId}-${normalized}`;
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function isLikelyMobileBrowser() {
    if (typeof navigator === 'undefined') return false;
    const ua = String(navigator.userAgent || '');
    return /Android|iPhone|iPad|iPod|Mobile/i.test(ua);
  }

  async function handleMobileDownloadClick({
    event,
    content,
    soulId,
    fileName = 'ASSET.md',
    showToast
  } = {}) {
    if (!content || !soulId || !isLikelyMobileBrowser()) return;

    const filename = `${soulId}-${String(fileName || 'ASSET.md').trim() || 'ASSET.md'}`;
    if (event?.preventDefault) {
      event.preventDefault();
    }

    if (navigator?.share && typeof File !== 'undefined') {
      try {
        const file = new File([content], filename, { type: 'text/markdown' });
        if (!navigator.canShare || navigator.canShare({ files: [file] })) {
          await navigator.share({
            title: filename,
            text: 'PULL.md file',
            files: [file]
          });
          return;
        }
      } catch (error) {
        if (error?.name === 'AbortError') return;
      }
    }

    try {
      const viewUrl = URL.createObjectURL(new Blob([content], { type: 'text/plain;charset=utf-8' }));
      const opened = window.open(viewUrl, '_blank', 'noopener,noreferrer');
      if (!opened) {
        window.location.href = viewUrl;
      }
      setTimeout(() => {
        try {
          URL.revokeObjectURL(viewUrl);
        } catch (_) {}
      }, 60 * 1000);
      if (typeof showToast === 'function') {
        showToast(`Opened ${String(fileName || 'ASSET.md')}. Use browser Share/Save to keep it locally.`, 'info');
      }
    } catch (_) {
      if (typeof showToast === 'function') {
        showToast(`Unable to open ${String(fileName || 'ASSET.md')}. Try again from My Assets.`, 'error');
      }
    }
  }

  globalScope.SoulStarterDownloadDelivery = {
    triggerMarkdownDownload,
    isLikelyMobileBrowser,
    handleMobileDownloadClick
  };
})(typeof window !== 'undefined' ? window : globalThis);
