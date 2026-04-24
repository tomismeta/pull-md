import {
  isTransactionHash,
  normalizeTransactionHash,
  verifyBlockchainEntitlementReceipt
} from './blockchain_receipts.js';
import { getAssetEntitlement, recordAssetEntitlement } from './entitlements.js';
import { verifyPurchaseReceipt, verifyRedownloadSessionToken, verifyWalletAuth } from './payments.js';

function isCreatorWalletForAsset({ asset, wallet }) {
  const creator = String(asset?.publishedBy || '').toLowerCase();
  const candidate = String(wallet || '').toLowerCase();
  return Boolean(creator && candidate && creator === candidate);
}

export async function resolveRedownloadEntitlement({
  asset,
  assetId,
  blockchainTransaction,
  clientModeRaw,
  delivery,
  receipt,
  redownloadSessionToken,
  sellerAddress,
  siweIdentity,
  strictAgentMode,
  wallet,
  authSignature,
  authTimestamp,
  redownloadHeaders
}) {
  let authWallet = String(wallet || '').toLowerCase();
  let usedSignedAuth = false;
  let entitlementSource = 'receipt';
  let entitlementTransaction = 'prior-entitlement';

  if (redownloadHeaders.hasReceiptRedownloadHeaders) {
    const receiptCheck = verifyPurchaseReceipt({
      receipt,
      wallet: authWallet,
      soulId: assetId
    });

    if (!receiptCheck.ok) {
      if (strictAgentMode) {
        return {
          ok: false,
          status: 401,
          telemetry: {
            errorCode: 'invalid_receipt_agent_mode',
            errorMessage: receiptCheck.error
          },
          body: {
            error: receiptCheck.error,
            code: 'invalid_receipt_agent_mode',
            client_mode: clientModeRaw || 'agent',
            flow_hint:
              'Strict agent redownload requires a valid receipt for this asset or the original settlement transaction hash. Reuse X-PURCHASE-RECEIPT from purchase success or provide X-BLOCKCHAIN-TRANSACTION.',
            required_headers: ['X-WALLET-ADDRESS', 'X-REDOWNLOAD-SIGNATURE', 'X-REDOWNLOAD-TIMESTAMP'],
            one_of: [['X-PURCHASE-RECEIPT'], ['X-BLOCKCHAIN-TRANSACTION']]
          }
        };
      }

      const storedEntitlement = await getAssetEntitlement({
        walletAddress: authWallet,
        assetId
      });
      if (!storedEntitlement) {
        return {
          ok: false,
          status: 401,
          telemetry: {
            errorCode: 'no_authoritative_entitlement',
            errorMessage: receiptCheck.error
          },
          body: {
            error: receiptCheck.error,
            flow_hint:
              'Receipt verification failed and no authoritative entitlement record was found for this wallet+asset. Reuse the original X-PURCHASE-RECEIPT, supply X-BLOCKCHAIN-TRANSACTION for a recorded settlement, or complete a fresh purchase.',
            entitlement_record: {
              checked: true,
              entitled: false
            }
          }
        };
      }

      entitlementSource = storedEntitlement.source || 'entitlement_record';
      entitlementTransaction = storedEntitlement.transaction_ref || 'prior-entitlement';
    } else {
      entitlementSource = 'receipt';
      entitlementTransaction = receiptCheck.transaction || 'prior-entitlement';
      await recordAssetEntitlement({
        walletAddress: authWallet,
        assetId,
        transactionRef: entitlementTransaction,
        source: 'receipt'
      }).catch(() => {});
    }
  } else {
    if (authSignature && authTimestamp) {
      const authCheck = await verifyWalletAuth({
        wallet,
        soulId: assetId,
        action: 'redownload',
        timestamp: authTimestamp,
        signature: authSignature,
        domain: siweIdentity.domain,
        uri: siweIdentity.uri
      });

      if (!authCheck.ok) {
        return {
          ok: false,
          status: 401,
          telemetry: {
            errorCode: 'wallet_auth_failed',
            errorMessage: authCheck.error
          },
          body: {
            error: authCheck.error,
            auth_debug: authCheck.auth_debug || null
          }
        };
      }
      authWallet = authCheck.wallet;
      usedSignedAuth = true;
    } else {
      const sessionCheck = verifyRedownloadSessionToken({
        token: String(redownloadSessionToken || ''),
        wallet: authWallet
      });
      if (!sessionCheck.ok) {
        return {
          ok: false,
          status: 401,
          telemetry: {
            errorCode: 'redownload_session_invalid',
            errorMessage: sessionCheck.error
          },
          body: {
            error: sessionCheck.error
          }
        };
      }
    }

    const creatorEntitled = isCreatorWalletForAsset({ asset, wallet: authWallet });
    if (!creatorEntitled) {
      const storedEntitlement = await getAssetEntitlement({
        walletAddress: authWallet,
        assetId
      });
      if (!storedEntitlement) {
        return {
          ok: false,
          status: 401,
          telemetry: {
            errorCode: 'no_receipt_or_entitlement'
          },
          body: {
            error: 'No receipt provided and wallet has no prior entitlement for this asset',
            flow_hint:
              'Session-only mode works for prior buyers and creators. This wallet has no authoritative ownership record for this asset yet.',
            entitlement_record: {
              checked: true,
              entitled: false
            }
          }
        };
      }

      if (redownloadHeaders.hasTransactionRedownloadHeaders) {
        const expectedTransaction = normalizeTransactionHash(storedEntitlement.transaction_ref);
        const submittedTransaction = normalizeTransactionHash(blockchainTransaction);
        if (!expectedTransaction || submittedTransaction !== expectedTransaction) {
          return {
            ok: false,
            status: 401,
            telemetry: {
              errorCode: 'blockchain_transaction_mismatch'
            },
            body: {
              error: 'Blockchain transaction does not match the authoritative entitlement record for this asset',
              code: 'blockchain_transaction_mismatch',
              flow_hint:
                'Use the settlement transaction hash returned from the successful purchase of this exact asset, or fall back to X-PURCHASE-RECEIPT.',
              expected_transaction_present: Boolean(expectedTransaction)
            }
          };
        }

        const receiptCheck = await verifyBlockchainEntitlementReceipt({
          transactionHash: submittedTransaction,
          walletAddress: authWallet,
          sellerAddress,
          minAmount: asset.priceMicroUsdc
        });
        if (!receiptCheck.ok) {
          return {
            ok: false,
            status: 401,
            telemetry: {
              errorCode: receiptCheck.code || 'blockchain_transaction_invalid',
              errorMessage: receiptCheck.error || null
            },
            body: {
              error: receiptCheck.error || 'Blockchain transaction could not be verified',
              code: receiptCheck.code || 'blockchain_transaction_invalid',
              flow_hint:
                'Provide the original successful settlement transaction hash for this asset on Base, or use X-PURCHASE-RECEIPT.',
              blockchain_receipt: receiptCheck.receipt || null
            }
          };
        }
        entitlementSource = 'blockchain_transaction';
        entitlementTransaction = submittedTransaction;
      } else {
        entitlementSource = storedEntitlement.source || 'entitlement_record';
        entitlementTransaction = storedEntitlement.transaction_ref || 'prior-entitlement';
      }
    } else {
      entitlementSource = 'creator';
      entitlementTransaction = 'creator-entitlement';
    }
  }

  return {
    ok: true,
    authWallet,
    entitlementSource,
    entitlementTransaction,
    usedSignedAuth,
    blockchainTransaction:
      isTransactionHash(entitlementTransaction) ? normalizeTransactionHash(entitlementTransaction) : null,
    deliveryMeta: {
      assetType: delivery.assetType,
      creatorAccess: entitlementSource === 'creator'
    }
  };
}
