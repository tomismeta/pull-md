import { applySuccessfulAssetDelivery } from './asset_download_delivery.js';
import {
  buildCopyPastePaymentPayloadTemplate,
  buildPaymentDebug,
  buildPaymentSigningInstructions,
  buildPaymentSigningInstructionsForMethod,
  buildSettlementDiagnostics,
  buildSettlementKey,
  decodePaymentRequiredHeader,
  decodeSubmittedPayment,
  extractX402Error,
  getPayerFromPaymentPayload,
  getTransferMethodFromSubmittedPayment,
  processSettlementWithRetries,
  PURCHASE_RECEIPT_SECURITY_HINT,
  rewriteIncomingPaymentHeader,
  runSingleFlightSettlement,
  shouldIncludeDebug,
  validatePaymentPayloadContract
} from './asset_download_x402.js';
import { getAssetEntitlement, recordAssetEntitlement } from './entitlements.js';
import { resolveAssetTransferMethodForRequest } from './asset_download_modes.js';
import { buildSiweChallengeFields } from './siwe.js';
import {
  applyInstructionResponse,
  buildCdpRequestDebug,
  createRequestContext,
  getX402HTTPServer,
  inspectFacilitatorVerify
} from './x402.js';
import { loadAssetContent } from './catalog.js';

const defaultDeps = {
  applyInstructionResponse,
  applySuccessfulAssetDelivery,
  buildCdpRequestDebug,
  buildCopyPastePaymentPayloadTemplate,
  buildPaymentDebug,
  buildPaymentSigningInstructions,
  buildPaymentSigningInstructionsForMethod,
  buildSettlementDiagnostics,
  buildSettlementKey,
  buildSiweChallengeFields,
  createRequestContext,
  decodePaymentRequiredHeader,
  decodeSubmittedPayment,
  extractX402Error,
  getAssetEntitlement,
  getPayerFromPaymentPayload,
  getTransferMethodFromSubmittedPayment,
  getX402HTTPServer,
  inspectFacilitatorVerify,
  loadAssetContent,
  processSettlementWithRetries,
  recordAssetEntitlement,
  resolveAssetTransferMethodForRequest,
  rewriteIncomingPaymentHeader,
  runSingleFlightSettlement,
  shouldIncludeDebug,
  validatePaymentPayloadContract
};

function applyResponseHeaders(res, headers = {}) {
  for (const [key, value] of Object.entries(headers || {})) {
    if (value != null) {
      res.setHeader(key, value);
    }
  }
}

function strictAgentRedownloadContract() {
  return {
    required_headers: ['X-WALLET-ADDRESS', 'X-REDOWNLOAD-SIGNATURE', 'X-REDOWNLOAD-TIMESTAMP'],
    one_of: [['X-PURCHASE-RECEIPT'], ['X-BLOCKCHAIN-TRANSACTION']],
    disallowed_headers: ['X-REDOWNLOAD-SESSION', 'X-AUTH-SIGNATURE', 'X-AUTH-TIMESTAMP']
  };
}

export async function handleAssetPurchaseRequest(
  {
    asset,
    assetId,
    clientModeRaw,
    delivery,
    hasAnyRedownloadHeaders,
    recordDownloadTelemetry,
    req,
    res,
    sellerAddress,
    siweIdentity,
    startMs,
    strictAgentMode,
    telemetryRoute,
    wallet,
    walletHintForQuote
  },
  deps = {}
) {
  const runtime = { ...defaultDeps, ...deps };

  try {
    runtime.rewriteIncomingPaymentHeader(req);
    const context = runtime.createRequestContext(req);
    const submittedPayment = context.paymentHeader ? runtime.decodeSubmittedPayment(req) : null;
    const transferMethodSelection = await runtime.resolveAssetTransferMethodForRequest(req, {
      strictAgentMode,
      wallet
    });

    if (strictAgentMode && !hasAnyRedownloadHeaders && !transferMethodSelection.method) {
      return res.status(400).json({
        error: 'Unable to resolve transfer method for strict agent flow',
        code: 'agent_transfer_method_unresolved',
        flow_hint:
          'Provide X-WALLET-ADDRESS and retry. Strict agent mode defaults to eip3009 unless X-ASSET-TRANSFER-METHOD is explicitly set.',
        required_headers: ['X-CLIENT-MODE: agent', 'X-WALLET-ADDRESS'],
        optional_headers: ['X-ASSET-TRANSFER-METHOD'],
        transfer_method_selection: transferMethodSelection
      });
    }

    if (strictAgentMode && submittedPayment && transferMethodSelection.method) {
      const submittedMethod = runtime.getTransferMethodFromSubmittedPayment
        ? runtime.getTransferMethodFromSubmittedPayment(submittedPayment)
        : String(submittedPayment?.accepted?.extra?.assetTransferMethod || 'eip3009').toLowerCase();
      if (submittedMethod !== transferMethodSelection.method) {
        return res.status(402).json({
          error: 'Payment transfer method mismatch',
          code: 'x402_method_mismatch',
          flow_hint:
            'The submitted PAYMENT-SIGNATURE method does not match this wallet quote. Refresh PAYMENT-REQUIRED and re-sign with the selected method.',
          expected_transfer_method: transferMethodSelection.method,
          submitted_transfer_method: submittedMethod,
          transfer_method_selection: transferMethodSelection,
          payment_signing_instructions: runtime.buildPaymentSigningInstructionsForMethod(transferMethodSelection.method)
        });
      }
    }

    const httpServer = await runtime.getX402HTTPServer({
      assetId,
      asset,
      sellerAddress,
      assetTransferMethod: transferMethodSelection.method
    });
    const result = await httpServer.processHTTPRequest(context);
    const includeDebug = runtime.shouldIncludeDebug(req);

    if (result.type === 'payment-error') {
      if (result.response?.body && typeof result.response.body === 'object') {
        const paymentRequired = runtime.decodePaymentRequiredHeader(result.response?.headers);
        const paymentSigningInstructions = runtime.buildPaymentSigningInstructions(paymentRequired);
        const paymentDebug = includeDebug ? runtime.buildPaymentDebug(req, paymentRequired) : null;
        if (paymentSigningInstructions) {
          result.response.body.payment_signing_instructions = paymentSigningInstructions;
        }

        if (!context.paymentHeader) {
          recordDownloadTelemetry({
            eventType: 'purchase.paywall_issued',
            route: telemetryRoute,
            action: 'purchase',
            walletAddress: walletHintForQuote || wallet || null,
            assetId,
            assetType: delivery.assetType,
            success: false,
            statusCode: Number(result.response?.status || 402),
            errorCode: 'payment_required',
            metadata: {
              strict_agent_mode: strictAgentMode === true,
              transfer_method: transferMethodSelection?.method || null,
              duration_ms: Date.now() - startMs
            }
          });
          result.response.body.transfer_method_selection = transferMethodSelection;
          if (strictAgentMode) {
            result.response.body.flow_hint =
              'Strict agent mode purchase step: send PAYMENT-SIGNATURE with base64-encoded x402 payload.';
            result.response.body.client_mode = clientModeRaw || 'agent';
            result.response.body.purchase_receipt_security_hint = PURCHASE_RECEIPT_SECURITY_HINT;
            result.response.body.redownload_contract = strictAgentRedownloadContract();
          } else {
            Object.assign(
              result.response.body,
              runtime.buildSiweChallengeFields({
                wallet: '0x<your-wallet>',
                soulId: assetId,
                action: 'redownload',
                siweIdentity
              })
            );
            result.response.body.flow_hint =
              'No payment header was detected. Send PAYMENT-SIGNATURE with base64-encoded x402 payload for purchase.';
            result.response.body.purchase_receipt_security_hint = PURCHASE_RECEIPT_SECURITY_HINT;
          }
        } else {
          recordDownloadTelemetry({
            eventType: 'purchase.payment_error',
            route: telemetryRoute,
            action: 'purchase',
            walletAddress: walletHintForQuote || wallet || null,
            assetId,
            assetType: delivery.assetType,
            success: false,
            statusCode: Number(result.response?.status || 402),
            errorCode: 'payment_header_rejected',
            metadata: {
              strict_agent_mode: strictAgentMode === true,
              transfer_method: transferMethodSelection?.method || null,
              duration_ms: Date.now() - startMs
            }
          });
          result.response.body.flow_hint =
            'Payment header was detected but could not be verified/settled. Regenerate PAYMENT-SIGNATURE from the latest PAYMENT-REQUIRED and retry.';
          result.response.body.purchase_receipt_security_hint = PURCHASE_RECEIPT_SECURITY_HINT;
          if (includeDebug) {
            const facilitatorVerify = await runtime.inspectFacilitatorVerify({
              paymentPayload: submittedPayment,
              paymentRequirements: paymentRequired?.accepts?.[0] || null,
              x402Version: paymentRequired?.x402Version ?? submittedPayment?.x402Version ?? 2
            });
            const copyPastePayload = runtime.buildCopyPastePaymentPayloadTemplate(paymentRequired);
            result.response.body.accepted_copy_paste = paymentRequired?.accepts?.[0] || null;
            result.response.body.copy_paste_payment_payload = copyPastePayload;
            result.response.body.copy_paste_header_hint =
              'PAYMENT-SIGNATURE: base64(JSON.stringify(copy_paste_payment_payload))';
            result.response.body.payment_debug = {
              ...paymentDebug,
              transfer_method_selection: transferMethodSelection,
              facilitator_verify: facilitatorVerify
            };
          }
        }
      }
      return runtime.applyInstructionResponse(res, result.response);
    }

    if (result.type !== 'payment-verified') {
      recordDownloadTelemetry({
        eventType: 'purchase.processing_failed',
        route: telemetryRoute,
        action: 'purchase',
        walletAddress: walletHintForQuote || wallet || null,
        assetId,
        assetType: delivery.assetType,
        success: false,
        statusCode: 500,
        errorCode: 'unexpected_x402_state'
      });
      return res.status(500).json({ error: 'Unexpected x402 processing state' });
    }

    const payloadContractCheck = runtime.validatePaymentPayloadContract({
      paymentPayload: result.paymentPayload,
      paymentRequirements: result.paymentRequirements
    });
    if (!payloadContractCheck.ok) {
      recordDownloadTelemetry({
        eventType: 'purchase.validation_failed',
        route: telemetryRoute,
        action: 'purchase',
        walletAddress: walletHintForQuote || wallet || null,
        assetId,
        assetType: delivery.assetType,
        success: false,
        statusCode: 402,
        errorCode: payloadContractCheck.code || 'invalid_payment_payload_contract'
      });
      return res.status(402).json({
        error: 'Invalid payment payload contract',
        code: payloadContractCheck.code,
        flow_hint: payloadContractCheck.flowHint,
        contract_requirements: payloadContractCheck.required || null,
        payment_signing_instructions: runtime.buildPaymentSigningInstructions({
          accepts: [result.paymentRequirements],
          x402Version: 2
        }),
        mismatch_hints: payloadContractCheck.mismatchHints || [],
        ...(includeDebug
          ? {
              payment_payload_shape: payloadContractCheck.shape || null,
              payment_payload_preview: payloadContractCheck.preview || null
            }
          : {})
      });
    }

    const content = await runtime.loadAssetContent(assetId, { asset });
    if (!content) {
      recordDownloadTelemetry({
        eventType: 'purchase.processing_failed',
        route: telemetryRoute,
        action: 'purchase',
        walletAddress: walletHintForQuote || wallet || null,
        assetId,
        assetType: delivery.assetType,
        success: false,
        statusCode: 500,
        errorCode: 'asset_unavailable'
      });
      return res.status(500).json({
        error: 'Asset unavailable'
      });
    }

    const payerHint = runtime.getPayerFromPaymentPayload(result.paymentPayload);
    const recordedEntitlement = payerHint
      ? await runtime.getAssetEntitlement({ walletAddress: payerHint, assetId })
      : null;
    if (recordedEntitlement) {
      recordDownloadTelemetry({
        eventType: 'purchase.settlement_success',
        route: telemetryRoute,
        action: 'purchase',
        walletAddress: payerHint || null,
        assetId,
        assetType: delivery.assetType,
        success: true,
        statusCode: 200,
        metadata: {
          settlement_source: recordedEntitlement.source || 'entitlement_record',
          transaction: recordedEntitlement.transaction_ref || 'prior-entitlement',
          duration_ms: Date.now() - startMs
        }
      });
      return runtime.applySuccessfulAssetDelivery({
        res,
        content,
        delivery,
        assetId,
        wallet: payerHint,
        transaction: recordedEntitlement.transaction_ref || 'prior-entitlement',
        entitlementSource: recordedEntitlement.source || 'entitlement_record',
        strictAgentMode,
        reqHost: req.headers.host,
        includeReceipt: true,
        includeRedownloadSession: false
      });
    }

    let settlementResult;
    try {
      const singleFlightKey = runtime.buildSettlementKey({
        assetId,
        paymentPayload: result.paymentPayload,
        paymentRequirements: result.paymentRequirements
      });
      settlementResult = await runtime.runSingleFlightSettlement(singleFlightKey, () =>
        runtime.processSettlementWithRetries(httpServer, {
          paymentPayload: result.paymentPayload,
          paymentRequirements: result.paymentRequirements,
          declaredExtensions: result.declaredExtensions
        })
      );
    } catch (error) {
      return res.status(402).json({
        error: 'Settlement threw an exception',
        settlement_debug: runtime.extractX402Error(error)
      });
    }

    const settlement = settlementResult.settlement;
    if (!settlement.success) {
      const settlementDiagnostics = includeDebug
        ? await runtime.buildSettlementDiagnostics({
            paymentPayload: result.paymentPayload,
            paymentRequirements: result.paymentRequirements
          })
        : null;
      const cdpSettleRequestDebug = includeDebug
        ? runtime.buildCdpRequestDebug({
            paymentPayload: result.paymentPayload,
            paymentRequirements: result.paymentRequirements,
            x402Version: result.paymentPayload?.x402Version ?? 2
          })
        : null;
      recordDownloadTelemetry({
        eventType: 'purchase.settlement_failed',
        route: telemetryRoute,
        action: 'purchase',
        walletAddress: runtime.getPayerFromPaymentPayload(result.paymentPayload),
        assetId,
        assetType: delivery.assetType,
        success: false,
        statusCode: 402,
        errorCode: 'settlement_failed',
        errorMessage: settlement.errorMessage || settlement.errorReason || null,
        metadata: {
          attempts: Array.isArray(settlementResult.attempts) ? settlementResult.attempts.length : 0,
          transfer_method: String(result.paymentRequirements?.extra?.assetTransferMethod || 'eip3009').toLowerCase(),
          duration_ms: Date.now() - startMs
        }
      });
      return res.status(402).json({
        error: 'Settlement failed',
        reason: settlement.errorReason,
        message: settlement.errorMessage,
        ...(includeDebug ? { settlement_diagnostics: settlementDiagnostics } : {}),
        settlement_attempts: settlementResult.attempts,
        ...(includeDebug
          ? {
              cdp_settle_request_preview: {
                top_level_x402Version: cdpSettleRequestDebug?.top_level_x402Version ?? null,
                transfer_method: cdpSettleRequestDebug?.transfer_method ?? null,
                paymentPayload_keys: cdpSettleRequestDebug?.paymentPayload_keys ?? [],
                paymentRequirements_keys: cdpSettleRequestDebug?.paymentRequirements_keys ?? [],
                paymentPayload_field_types: cdpSettleRequestDebug?.paymentPayload_field_types ?? null,
                paymentPayload_field_checks: cdpSettleRequestDebug?.paymentPayload_field_checks ?? null
              },
              cdp_settle_request_redacted: cdpSettleRequestDebug?.cdp_request_redacted ?? null
            }
          : {})
      });
    }

    applyResponseHeaders(res, settlement.headers || {});

    if (settlement.success && settlement.payer) {
      await runtime.recordAssetEntitlement({
        walletAddress: settlement.payer,
        assetId,
        transactionRef: settlement.transaction || 'prior-entitlement',
        source: 'purchase',
        metadata: {
          transfer_method: String(result.paymentRequirements?.extra?.assetTransferMethod || 'eip3009').toLowerCase()
        }
      }).catch(() => {});
    }

    recordDownloadTelemetry({
      eventType: 'purchase.settlement_success',
      route: telemetryRoute,
      action: 'purchase',
      walletAddress: settlement.payer || runtime.getPayerFromPaymentPayload(result.paymentPayload),
      assetId,
      assetType: delivery.assetType,
      success: true,
      statusCode: 200,
      metadata: {
        transaction: settlement.transaction || null,
        transfer_method: String(result.paymentRequirements?.extra?.assetTransferMethod || 'eip3009').toLowerCase(),
        duration_ms: Date.now() - startMs
      }
    });
    return runtime.applySuccessfulAssetDelivery({
      res,
      content,
      delivery,
      assetId,
      wallet: settlement.payer || runtime.getPayerFromPaymentPayload(result.paymentPayload),
      transaction: settlement.transaction,
      entitlementSource: 'purchase',
      strictAgentMode,
      reqHost: req.headers.host,
      includeReceipt: true,
      includeRedownloadSession: true
    });
  } catch (error) {
    console.error('x402 processing failed:', error);
    recordDownloadTelemetry({
      eventType: 'purchase.processing_failed',
      route: telemetryRoute,
      action: 'purchase',
      walletAddress: walletHintForQuote || wallet || null,
      assetId,
      assetType: delivery.assetType,
      success: false,
      statusCode: 500,
      errorCode: 'x402_processing_failed',
      errorMessage: error instanceof Error ? error.message : String(error || 'x402_processing_failed'),
      metadata: {
        duration_ms: Date.now() - startMs
      }
    });
    return res.status(500).json({
      error: 'Payment processing failed',
      processing_debug: runtime.extractX402Error(error)
    });
  }
}
