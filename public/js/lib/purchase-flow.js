(function attachSoulStarterPurchaseFlow(globalScope) {
  if (!globalScope || typeof globalScope !== 'object') return;

  function createController(options = {}) {
    let activeSuccessDownloadUrl = null;
    let latestSoulDownload = null;
    let settlementVerificationSequence = 0;

    function getWalletAddress() {
      return typeof options.getWalletAddress === 'function' ? options.getWalletAddress() : null;
    }

    function getSigner() {
      return typeof options.getSigner === 'function' ? options.getSigner() : null;
    }

    function revokeActiveSuccessDownloadUrl() {
      if (!activeSuccessDownloadUrl) return;
      try {
        URL.revokeObjectURL(activeSuccessDownloadUrl);
      } catch (_) {}
      activeSuccessDownloadUrl = null;
    }

    async function handleSuccessDownloadClick(event) {
      if (!latestSoulDownload || typeof options.isLikelyMobileBrowser !== 'function') return;
      if (!options.isLikelyMobileBrowser()) return;
      const { content, soulId, fileName } = latestSoulDownload;
      if (typeof options.handleMobileDownloadClick === 'function') {
        await options.handleMobileDownloadClick({
          event,
          content,
          soulId,
          fileName,
          showToast: options.showToast
        });
      }
    }

    function showPaymentSuccess(content, txRef, soulId, redownload, expectedSettlement = null, fileNameHint = null) {
      const txHash = typeof txRef === 'string' ? txRef : null;
      settlementVerificationSequence += 1;
      const verificationRunId = settlementVerificationSequence;
      const fileName = String(fileNameHint || latestSoulDownload?.fileName || 'ASSET.md').trim() || 'ASSET.md';
      latestSoulDownload = { content, soulId, fileName };

      const purchaseCard = document.getElementById('purchaseCard');
      if (purchaseCard) purchaseCard.style.display = 'none';

      const successCard = document.getElementById('successCard');
      const downloadLink = document.getElementById('downloadLink');
      if (successCard) {
        successCard.style.display = 'block';
        const heading = successCard.querySelector('h3');
        if (heading) {
          heading.textContent = redownload ? 'Soul Restored!' : 'Soul Acquired!';
        }

        const firstP = successCard.querySelector('p');
        if (firstP) {
          firstP.textContent = redownload
            ? 'Entitlement verified via wallet re-authentication.'
            : 'x402 payment settled successfully.';
        }
      }

      if (downloadLink) {
        revokeActiveSuccessDownloadUrl();
        activeSuccessDownloadUrl = URL.createObjectURL(new Blob([content], { type: 'text/markdown' }));
        downloadLink.href = activeSuccessDownloadUrl;
        downloadLink.download = `${soulId}-${fileName}`;
        downloadLink.textContent = `Download ${fileName}`;
        downloadLink.onclick = handleSuccessDownloadClick;
      }

      if (typeof options.triggerMarkdownDownload === 'function') {
        try {
          options.triggerMarkdownDownload(content, soulId, fileName);
        } catch (_) {}
      }

      const txHashEl = document.getElementById('txHash');
      if (txHashEl && successCard) {
        txHashEl.textContent = '';
        if (txHash) {
          txHashEl.appendChild(document.createTextNode('Transaction: '));
          const link = document.createElement('a');
          link.href = `https://basescan.org/tx/${encodeURIComponent(txHash)}`;
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
          link.textContent = `${txHash.slice(0, 10)}...${txHash.slice(-8)}`;
          txHashEl.appendChild(link);
        } else {
          txHashEl.textContent = 'Transaction: prior entitlement';
        }
      }

      if (redownload || !txHash || !expectedSettlement) {
        if (typeof options.renderSettlementVerification === 'function') {
          options.renderSettlementVerification({ phase: 'hidden' });
        }
        return;
      }

      if (typeof options.renderSettlementVerification === 'function') {
        options.renderSettlementVerification({ phase: 'pending' });
      }

      if (typeof options.verifySettlementOnchain !== 'function') return;

      options
        .verifySettlementOnchain(txHash, expectedSettlement)
        .then((result) => {
          if (verificationRunId !== settlementVerificationSequence) return;
          if (result.verified) {
            if (typeof options.renderSettlementVerification === 'function') {
              options.renderSettlementVerification({
                phase: 'verified',
                actual: result.actual,
                expected: result.expected
              });
            }
            return;
          }
          if (typeof options.renderSettlementVerification === 'function') {
            options.renderSettlementVerification({
              phase: 'warn',
              reason: result.reason,
              expected: result.expected
            });
          }
        })
        .catch(() => {
          if (verificationRunId !== settlementVerificationSequence) return;
          if (typeof options.renderSettlementVerification === 'function') {
            options.renderSettlementVerification({
              phase: 'warn',
              reason: 'Unable to verify settlement right now. You can still inspect the transaction on BaseScan.',
              expected: expectedSettlement
            });
          }
        });
    }

    function markSoulOwned(soulId) {
      if (typeof options.markSoulOwned === 'function') {
        options.markSoulOwned(soulId);
      }
    }

    async function purchaseSoul(soulId, fileNameHint = null) {
      const walletAddress = getWalletAddress();
      const signer = getSigner();
      if (!walletAddress || !signer) {
        if (typeof options.showToast === 'function') options.showToast('Connect wallet first', 'warning');
        if (typeof options.openWalletModal === 'function') options.openWalletModal();
        return;
      }

      const btn = document.getElementById('buyBtn');
      try {
        if (btn) {
          btn.disabled = true;
          btn.textContent = 'Checking access...';
        }

        if (typeof options.ensureBaseNetwork === 'function') {
          await options.ensureBaseNetwork();
        }

        const prior = await options.tryRedownload(soulId);
        if (prior.ok) {
          markSoulOwned(soulId);
          if (typeof options.loadSouls === 'function') options.loadSouls();
          if (typeof options.updateSoulPagePurchaseState === 'function') options.updateSoulPagePurchaseState();
          if (typeof options.showToast === 'function') {
            options.showToast('Entitlement verified. Download restored.', 'success');
          }
          return;
        }

        if (btn) btn.textContent = 'Requesting x402 terms...';
        const expectedSeller = await options.getExpectedSellerAddressForSoul(soulId);
        const x402Engine = await options.createX402SdkEngine({
          wallet: walletAddress,
          activeSigner: signer,
          expectedSeller,
          preferredAssetTransferMethod: 'eip3009'
        });
        const initial = await options.fetchWithTimeout(
          `${options.apiBase}/assets/${encodeURIComponent(soulId)}/download`,
          {
            method: 'GET',
            headers: {
              Accept: 'application/json',
              'X-WALLET-ADDRESS': walletAddress,
              'X-ASSET-TRANSFER-METHOD': 'eip3009'
            }
          }
        );

        if (initial.status !== 402) {
          const error = await options.readError(initial);
          throw new Error(error || `Expected 402 payment required (got ${initial.status})`);
        }

        const paymentRequired = await options.decodePaymentRequiredWithSdk(initial, x402Engine.httpClient);
        if (btn) btn.textContent = 'Signing x402 payment...';
        const paymentPayload = await options.buildX402PaymentSignature(paymentRequired, soulId, x402Engine);

        if (btn) btn.textContent = 'Submitting payment...';
        const paid = await options.fetchWithTimeout(`${options.apiBase}/assets/${encodeURIComponent(soulId)}/download`, {
          method: 'GET',
          headers: {
            'PAYMENT-SIGNATURE': btoa(JSON.stringify(paymentPayload)),
            'X-WALLET-ADDRESS': walletAddress,
            'X-ASSET-TRANSFER-METHOD': 'eip3009',
            Accept: 'text/markdown'
          }
        });

        if (!paid.ok) {
          const error = await options.readError(paid);
          throw new Error(error || 'Payment failed');
        }

        const settlementResponse = options.readSettlementResponse(paid);
        if (!settlementResponse?.success) {
          throw new Error('Payment did not include a confirmed settlement response');
        }

        const content = await paid.text();
        const deliveredFileName = String(
          settlementResponse?.fileName ||
            settlementResponse?.assetDelivered?.fileName ||
            fileNameHint ||
            'ASSET.md'
        ).trim() || 'ASSET.md';
        const tx = settlementResponse.transaction || null;
        const receipt = paid.headers.get('X-PURCHASE-RECEIPT');
        if (receipt && typeof options.storeReceipt === 'function') {
          options.storeReceipt(soulId, walletAddress, receipt);
        }
        markSoulOwned(soulId);

        const expectedSettlement = {
          token: paymentPayload?.accepted?.asset || null,
          amount: paymentPayload?.accepted?.amount || null,
          payTo: paymentPayload?.accepted?.payTo || null,
          payer: walletAddress,
          network: paymentPayload?.accepted?.network || null
        };
        showPaymentSuccess(content, tx, soulId, false, expectedSettlement, deliveredFileName);
        if (typeof options.showToast === 'function') options.showToast('Asset acquired successfully.', 'success');
        if (typeof options.loadSouls === 'function') options.loadSouls();
        if (typeof options.updateSoulPagePurchaseState === 'function') options.updateSoulPagePurchaseState();
      } catch (error) {
        console.error('Purchase failed:', error);
        if (typeof options.showToast === 'function') {
          options.showToast(`Purchase failed: ${error.message || 'Unknown error'}`, 'error');
        }
      } finally {
        if (btn) {
          btn.disabled = false;
          btn.textContent = `Purchase ${String(fileNameHint || 'ASSET.md')}`;
        }
      }
    }

    async function downloadOwnedSoul(soulId, fileNameHint = null) {
      const walletAddress = getWalletAddress();
      const signer = getSigner();
      if (!walletAddress || !signer) {
        if (typeof options.showToast === 'function') options.showToast('Connect your wallet first', 'warning');
        if (typeof options.openWalletModal === 'function') options.openWalletModal();
        return;
      }
      try {
        if (typeof options.ensureBaseNetwork === 'function') {
          await options.ensureBaseNetwork();
        }
        const prior = await options.tryRedownload(soulId);
        if (prior.ok) {
          if (typeof fileNameHint === 'string' && latestSoulDownload) {
            latestSoulDownload.fileName = fileNameHint;
          }
          if (typeof options.showToast === 'function') {
            options.showToast('Download restored from your entitlement.', 'success');
          }
          return;
        }
        if (typeof options.showToast === 'function') {
          options.showToast('No purchase or creator entitlement found for this soul on this wallet.', 'warning');
        }
      } catch (error) {
        if (typeof options.showToast === 'function') {
          options.showToast(`Download failed: ${error.message || 'Unknown error'}`, 'error');
        }
      }
    }

    return {
      purchaseSoul,
      downloadOwnedSoul,
      showPaymentSuccess,
      revokeActiveSuccessDownloadUrl
    };
  }

  globalScope.SoulStarterPurchaseFlow = {
    createController
  };
})(typeof window !== 'undefined' ? window : globalThis);
