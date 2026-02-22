(function attachPullMdSdkLoader(globalScope) {
  if (!globalScope || typeof globalScope !== 'object') return;

  const scriptLoadPromises = new Map();

  function ensureScript({ key, src, testReady, timeoutMs = 15000 } = {}) {
    const cacheKey = String(key || src || '').trim();
    if (!cacheKey || !src || typeof testReady !== 'function') {
      return Promise.reject(new Error('Invalid script loader options'));
    }

    if (testReady()) {
      return Promise.resolve();
    }

    if (scriptLoadPromises.has(cacheKey)) {
      return scriptLoadPromises.get(cacheKey);
    }

    const promise = new Promise((resolve, reject) => {
      const existing = document.querySelector(`script[data-pullmd-loader="${cacheKey}"]`);
      if (existing && testReady()) {
        resolve();
        return;
      }

      const script = existing || document.createElement('script');
      if (!existing) {
        script.src = src;
        script.async = true;
        script.defer = true;
        script.crossOrigin = 'anonymous';
        script.dataset.pullmdLoader = cacheKey;
        document.head.appendChild(script);
      }

      const timeoutId = setTimeout(() => {
        scriptLoadPromises.delete(cacheKey);
        reject(new Error(`Timed out loading script: ${src}`));
      }, Math.max(1000, Number(timeoutMs) || 15000));

      const finish = () => {
        clearTimeout(timeoutId);
      };

      script.addEventListener(
        'load',
        () => {
          finish();
          if (!testReady()) {
            scriptLoadPromises.delete(cacheKey);
            reject(new Error(`Script loaded but SDK unavailable: ${src}`));
            return;
          }
          resolve();
        },
        { once: true }
      );

      script.addEventListener(
        'error',
        () => {
          finish();
          scriptLoadPromises.delete(cacheKey);
          reject(new Error(`Failed to load script: ${src}`));
        },
        { once: true }
      );
    });

    scriptLoadPromises.set(cacheKey, promise);
    return promise;
  }

  function ensureEthersLoaded() {
    return ensureScript({
      key: 'ethers',
      src: 'https://unpkg.com/ethers@6.16.0/dist/ethers.umd.min.js',
      testReady: () => Boolean(globalScope.ethers)
    });
  }

  function ensureEmblemAuthSdkLoaded() {
    return ensureScript({
      key: 'emblem-auth-sdk',
      src: 'https://unpkg.com/@emblemvault/auth-sdk@2.3.17/dist/emblem-auth.min.js',
      testReady: () =>
        Boolean(globalScope.EmblemAuth && typeof globalScope.EmblemAuth.EmblemAuthSDK === 'function')
    });
  }

  globalScope.PullMdSdkLoader = {
    ensureScript,
    ensureEthersLoaded,
    ensureEmblemAuthSdkLoaded
  };
})(typeof window !== 'undefined' ? window : globalThis);
