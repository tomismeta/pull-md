(function attachPullMdSettlementUi(globalScope) {
  if (!globalScope || typeof globalScope !== 'object') return;

  function readSettlementResponse(response) {
    const header = response?.headers?.get?.('PAYMENT-RESPONSE');
    if (!header) return null;
    try {
      return JSON.parse(atob(header));
    } catch (_) {
      return null;
    }
  }

  function readSettlementTx(response) {
    const payload = readSettlementResponse(response);
    return payload?.transaction || null;
  }

  function renderSettlementVerification(panel, view, { escapeHtml, shortenAddress, formatMicroUsdc } = {}) {
    if (!panel) return;
    const safeEscape = typeof escapeHtml === 'function' ? escapeHtml : (value) => String(value || '');
    const safeShort = typeof shortenAddress === 'function' ? shortenAddress : (value) => String(value || '-');
    const safeFormatAmount = typeof formatMicroUsdc === 'function' ? formatMicroUsdc : (value) => String(value || '-');

    if (!view || view.phase === 'hidden') {
      panel.style.display = 'none';
      panel.className = 'settlement-verification';
      panel.innerHTML = '';
      return;
    }

    panel.style.display = 'block';
    if (view.phase === 'pending') {
      panel.className = 'settlement-verification settlement-verification-pending';
      panel.innerHTML = `
      <div class="settlement-verification-header">
        <strong>Verifying settlement</strong>
      </div>
      <p>Confirming on-chain USDC transfer details.</p>
    `;
      return;
    }

    if (view.phase === 'verified') {
      const actual = view.actual || {};
      panel.className = 'settlement-verification settlement-verification-ok';
      panel.innerHTML = `
      <div class="settlement-verification-header">
        <strong>Verified settlement</strong>
        <span class="verification-pill verification-pill-ok">Verified</span>
      </div>
      <p>This transaction matches PULL.md payment expectations.</p>
      <dl class="verification-grid">
        <dt>Payer</dt><dd>${safeEscape(safeShort(actual.from || view.expected?.payer || '-'))}</dd>
        <dt>Pay To</dt><dd>${safeEscape(safeShort(actual.to || view.expected?.payTo || '-'))}</dd>
        <dt>Amount</dt><dd>${safeEscape(safeFormatAmount(actual.amount || view.expected?.amount || null))}</dd>
        <dt>Token</dt><dd>${safeEscape(safeShort(view.expected?.token || '-'))}</dd>
      </dl>
    `;
      return;
    }

    panel.className = 'settlement-verification settlement-verification-warn';
    panel.innerHTML = `
    <div class="settlement-verification-header">
      <strong>Settlement not verified</strong>
      <span class="verification-pill verification-pill-warn">Check manually</span>
    </div>
    <p>${safeEscape(view.reason || 'Transaction details did not match expected settlement fields.')}</p>
    <dl class="verification-grid">
      <dt>Expected Pay To</dt><dd>${safeEscape(safeShort(view.expected?.payTo || '-'))}</dd>
      <dt>Expected Amount</dt><dd>${safeEscape(safeFormatAmount(view.expected?.amount || null))}</dd>
      <dt>Expected Token</dt><dd>${safeEscape(safeShort(view.expected?.token || '-'))}</dd>
    </dl>
  `;
  }

  globalScope.PullMdSettlementUi = {
    readSettlementResponse,
    readSettlementTx,
    renderSettlementVerification
  };
})(typeof window !== 'undefined' ? window : globalThis);
