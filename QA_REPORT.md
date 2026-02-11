# SoulStarter QA Report
**Date:** 2026-02-11  
**Scope:** x402-powered agent memory marketplace  
**Files Reviewed:**
- `api/souls/[id]/download.js`
- `public/js/app.js`
- `public/index.html`
- `public/soul.html`
- `public/css/styles.css`

---

## 🐛 BUGS FOUND

### 🔴 CRITICAL

#### 1. Missing Nonce Replay Protection (API)
**File:** `api/souls/[id]/download.js`  
**Line:** 23-28  
**Issue:** Nonce is generated but never validated for uniqueness. An attacker could replay the same payment signature multiple times to download the soul repeatedly without paying.
```javascript
nonce: Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15)
// Nonce is created but never stored/validated!
```
**Fix:** Store used nonces in Redis/database with TTL, or verify via facilitator's state.

#### 2. Race Condition in Payment Settlement (API)
**File:** `api/souls/[id]/download.js`  
**Line:** 88-98  
**Issue:** Settlement is fire-and-forget without proper error handling. If settlement fails, the user got the content but payment may not be captured.
```javascript
fetch(`${CONFIG.facilitator}/settle`, {...}).catch(console.error);
// Content is returned BEFORE settlement completes!
```
**Fix:** Await settlement or use a queue system with retry logic.

#### 3. No Token Approval Flow (Frontend)
**File:** `public/js/app.js`  
**Issue:** The code assumes USDC is already approved for spending. First-time users will have their transaction fail because they haven't approved the token contract.
**Fix:** Add ERC-20 approval step before signing payment.

---

### 🟠 HIGH

#### 4. Missing Network Change Handler (Frontend)
**File:** `public/js/app.js`  
**Line:** 44-47  
**Issue:** Only `accountsChanged` is handled. If user switches from Base to Ethereum mainnet, the UI still shows "connected" but transactions will fail.
```javascript
window.ethereum.on('accountsChanged', (newAccounts) => {
  // Missing: chainChanged handler
```
**Fix:** Add `chainChanged` listener and re-validate network.

#### 5. Malformed Base64 Handling (Frontend)
**File:** `public/js/app.js`  
**Line:** 114, 171  
**Issue:** `atob()` is used without try/catch. Malformed base64 will crash the purchase flow.
```javascript
const requirements = JSON.parse(atob(paymentRequiredB64));
// No error handling for invalid base64!
```
**Fix:** Wrap in try/catch with user-friendly error message.

#### 6. Wrong Error Message on Server Errors (Frontend)
**File:** `public/js/app.js`  
**Line:** 108-110  
**Issue:** Any non-402 status shows "Expected 402 Payment Required" even if server returns 500.
```javascript
if (response.status !== 402) {
  throw new Error('Expected 402 Payment Required'); // Wrong for 500 errors!
}
```
**Fix:** Check status codes properly and show appropriate messages.

---

### 🟡 MEDIUM

#### 7. No Timeout on Facilitator Calls (API)
**File:** `api/souls/[id]/download.js`  
**Line:** 64-76  
**Issue:** `fetch()` to Coinbase facilitator has no timeout. A hanging request will exhaust serverless function duration.
**Fix:** Add AbortController with 10s timeout.

#### 8. Missing Content-Type Validation (API)
**File:** `api/souls/[id]/download.js`  
**Issue:** Endpoint accepts any Content-Type but only handles JSON responses properly.

#### 9. Popup Blocker Issues (Frontend)
**File:** `public/js/app.js`  
**Line:** 25  
**Issue:** `window.open('https://metamask.io', '_blank')` may be blocked by popup blockers when called asynchronously.
**Fix:** Show inline UI with link instead of window.open.

#### 10. Hardcoded Fallback Seller Address (API)
**File:** `api/souls/[id]/download.js`  
**Line:** 18  
**Issue:** Seller address fallback is hardcoded. If env var is missing, payments go to wrong address.
```javascript
sellerAddress: process.env.SELLER_ADDRESS || '0xd5837ea218116aD34A19eF86eC77D3d328c20195'
```
**Fix:** Fail on startup if SELLER_ADDRESS is not set.

---

### 🟢 LOW

#### 11. Memory Leak in Toast Notifications (Frontend)
**File:** `public/js/app.js`  
**Line:** 227-240  
**Issue:** If user spams actions, toasts accumulate in DOM before timeout removes them.
**Fix:** Limit concurrent toasts or use a queue.

#### 12. Incorrect use of `selectedAddress` (Frontend)
**File:** `public/js/app.js`  
**Line:** 259-262  
**Issue:** `window.ethereum.selectedAddress` is deprecated. EIP-1193 uses `eth_accounts`.
```javascript
if (window.ethereum && window.ethereum.selectedAddress) { // Deprecated!
```

#### 13. No Input Sanitization on Soul ID (API)
**File:** `api/souls/[id]/download.js`  
**Issue:** `id` parameter from query is used directly in env var lookup without sanitization.
```javascript
const soulContent = process.env[`SOUL_${id.replace(/-/g, '_').toUpperCase()}`];
```
**Risk:** Potential prototype pollution or unexpected env var access.

---

## ⚠️ EDGE CASES NOT HANDLED

### User Without Wallet
| Scenario | Current Behavior | Expected |
|----------|-----------------|----------|
| No `window.ethereum` | Shows toast + opens metamask.io | Inline CTA with install instructions |
| Wallet locked | "No accounts found" toast | Prompt to unlock wallet |
| Wallet rejects connection | Generic "Failed to connect" | Specific "Connection rejected by user" |

### Network Issues
| Scenario | Current Behavior | Expected |
|----------|-----------------|----------|
| User on wrong network | Auto-switches without explaining why | Show "Switching to Base..." with explanation |
| Network switch mid-transaction | No handler | Cancel transaction, show warning |
| Base RPC down | Silent failure | Show "Network unavailable" with retry |

### Payment Flow
| Scenario | Current Behavior | Expected |
|----------|-----------------|----------|
| User rejects signature | Generic error | "Payment cancelled" - non-error toast |
| Insufficient USDC balance | Transaction fails on-chain | Pre-check balance, show "Insufficient funds" |
| Facilitator rejects payment | "Payment failed" | Specific reason (expired, invalid signature, etc.) |
| Facilitator timeout | Hangs indefinitely | 10s timeout with "Try again" option |

### Browser/State Issues
| Scenario | Current Behavior | Expected |
|----------|-----------------|----------|
| Page refresh mid-payment | State lost completely | Store pending tx in sessionStorage, resume on load |
| User clicks "Buy" twice | Double payment attempt | Disable button immediately, show loading state |
| Mobile browser backgrounded | Connection may drop | Re-check connection on visibilitychange |
| Wallet extension updated mid-flow | Possible disconnection | Re-verify connection before signing |

### Mobile-Specific
| Scenario | Current Behavior | Expected |
|----------|-----------------|----------|
| MetaMask mobile in-app browser | May not inject ethereum properly | Test and provide fallback instructions |
| iOS Safari with WalletConnect | Not supported at all | Show "Use desktop or MetaMask app" |
| Small screen (< 375px) | Layout breaks (see CSS) | Fix responsive breakpoints |

---

## 🛡️ ERROR HANDLING GAPS

### API (`download.js`)

| Location | Issue | Severity |
|----------|-------|----------|
| Line 64-76 | Facilitator fetch has no timeout | HIGH |
| Line 88-98 | Settlement errors silently logged only | HIGH |
| Line 50 | `paymentSignature` base64 decode not wrapped | MEDIUM |
| Line 55 | Missing validation: payment amount matches expected | CRITICAL |
| Line 55 | Missing validation: recipient matches seller | CRITICAL |
| Line 55 | Missing validation: timestamp not expired | HIGH |
| Line 100 | Generic 500 error, no retry guidance | MEDIUM |
| Line 23-28 | Nonce uniqueness not enforced | CRITICAL |

### Frontend (`app.js`)

| Location | Issue | Severity |
|----------|-------|----------|
| Line 44 | No `chainChanged` handler | HIGH |
| Line 108 | Wrong error for non-402 statuses | MEDIUM |
| Line 114 | `atob()` without try/catch | MEDIUM |
| Line 171 | `atob()` without try/catch | MEDIUM |
| Line 233 | `personal_sign` rejection not distinguished from errors | MEDIUM |
| Line 259 | `selectedAddress` deprecated | LOW |
| Line 26 | No check if popup was blocked | MEDIUM |

---

## 🎨 UX ISSUES

### Confusing Flows

1. **Auto-network switch without explanation**  
   When `switchToBase()` is called, user sees MetaMask popup but doesn't know why.  
   **Fix:** Show "We need to switch to Base network for USDC payments" before calling.

2. **"Expected 402" error on server failure**  
   If server returns 500, user sees confusing message about expecting 402.  
   **Fix:** Show "Server error, please try again" for 5xx errors.

3. **No payment progress indication**  
   Between "sign the payment" and "verifying payment" there's no visual feedback.  
   **Fix:** Add stepper UI: 1) Sign → 2) Verify → 3) Download

4. **Success card shows without download starting**  
   Auto-download may be blocked by popup blockers. User thinks it worked but no file.  
   **Fix:** Show explicit "Click to download" button, auto-click is backup only.

### Missing Feedback

5. **No balance check before purchase**  
   User only finds out they have no USDC after signing attempt fails.  
   **Fix:** Query USDC balance on wallet connect, show warning if < $0.50.

6. **No transaction status polling**  
   If txHash is "pending", it's never updated to confirmed.  
   **Fix:** Poll for confirmation and update UI.

7. **Toast disappears too quickly**  
   4 seconds may not be enough to read error details.  
   **Fix:** Increase to 6s for errors, add close button.

### Accessibility Issues

8. **Toast notifications not announced to screen readers**  
   Add `role="alert"` and `aria-live="polite"` to toast container.

9. **Button loading states lack accessibility**  
   Add `aria-busy="true"` and `aria-label="Processing purchase"` when disabled.

10. **Color contrast issues**  
   `--text-muted: #64748b` on `--bg-secondary: #12121a` may fail WCAG AA on some displays.

---

## 🌐 BROWSER COMPATIBILITY

### Modern JS Features Used

| Feature | Support | Risk |
|---------|---------|------|
| `async/await` | IE11- ❌ | Low (IE11 dead) |
| `fetch()` | IE11- ❌ | Low (polyfill available) |
| `atob/btoa` | IE9+ ✅ | None |
| `const/let` | IE11 ⚠️ | Low |
| `arrow functions` | IE11- ❌ | Low |
| `template literals` | IE11- ❌ | Low |
| `Object.entries` | Not used | - |

### Compatibility Issues Found

1. **`window.ethereum` injection varies by wallet:**
   - MetaMask: ✅ Injects before page load
   - Coinbase Wallet: ✅ Injects before page load
   - Trust Wallet: ⚠️ May inject asynchronously
   - Rainbow: ⚠️ May inject asynchronously
   
   **Fix:** Poll for `window.ethereum` if not immediately available:
   ```javascript
   const getEthereum = () => new Promise((resolve) => {
     if (window.ethereum) return resolve(window.ethereum);
     let attempts = 0;
     const interval = setInterval(() => {
       if (window.ethereum) {
         clearInterval(interval);
         resolve(window.ethereum);
       }
       if (++attempts > 20) clearInterval(interval);
     }, 100);
   });
   ```

2. **`personal_sign` vs `eth_sign`:**
   - Some wallets don't support `personal_sign`
   - **Fix:** Fallback to `eth_signTypedData_v4` for better compatibility

3. **ES6 modules not used:**
   - Code uses global script tags
   - **Risk:** Namespace pollution
   - **Fix:** Use modules or wrap in IIFE

4. **No feature detection for fetch:**
   - Assumes fetch exists (modern browsers only)
   - **Fix:** Add polyfill or check `if (!window.fetch) return showOldBrowserMessage()`

---

## 📱 RESPONSIVE DESIGN ISSUES

### CSS Breakpoint Analysis (`styles.css`)

| Element | Desktop | Tablet | Mobile (<768px) | Issues |
|---------|---------|--------|-----------------|--------|
| `hero-title` | 3rem | 3rem | 2rem | ✅ Good |
| `souls-grid` | 350px auto | 350px auto | 1fr | ✅ Good |
| `soul-hero` | row | row | column | ⚠️ Icon too large on mobile |
| `soul-content-grid` | 1fr 380px | 1fr 380px | 1fr | ✅ Good |
| `nav-link` | visible | visible | `display: none` | ⚠️ Navigation hidden on mobile! |

### Specific Issues

1. **Navigation links hidden on mobile (Line 447)**
   ```css
   @media (max-width: 768px) {
     .nav-link { display: none; } /* Users can't navigate! */
   }
   ```
   **Fix:** Use hamburger menu or keep essential links visible.

2. **Soul icon too large on mobile**
   At 4rem on mobile, the emoji takes too much vertical space.
   **Fix:** Reduce to 3rem on mobile.

3. **Toast position covers critical UI on mobile**
   Fixed bottom-right may cover buttons on small screens.
   **Fix:** Move to top on mobile, or make dismissible.

4. **Purchase card not sticky on mobile (Line 443)**
   ```css
   .soul-purchase { position: static; }
   ```
   User must scroll to see price after reading description.
   **Fix:** Keep price visible at top on mobile.

5. **Button touch targets may be too small**
   Wallet button is 32px tall - below recommended 44px.
   **Fix:** Increase to min 44px height.

6. **No landscape mobile support**
   Layout may break in landscape orientation on phones.
   **Fix:** Test and adjust grid for 568px height landscape.

7. **Font size may be too small on high-DPI mobile**
   0.75rem = ~12px, which may be unreadable on some devices.
   **Fix:** Use 0.875rem (14px) minimum for body text.

---

## 🧪 TEST COVERAGE GAPS

### What's NOT Tested (But Should Be)

#### Unit Tests Needed

| Component | Test Case | Priority |
|-----------|-----------|----------|
| `download.js` | Valid payment signature accepted | CRITICAL |
| `download.js` | Replay attack with same nonce rejected | CRITICAL |
| `download.js` | Expired timestamp rejected | HIGH |
| `download.js` | Wrong amount rejected | CRITICAL |
| `download.js` | Wrong recipient rejected | CRITICAL |
| `download.js` | Invalid soul ID returns 404 | MEDIUM |
| `download.js` | Facilitator timeout handled | HIGH |
| `download.js` | Facilitator returns 500 | MEDIUM |
| `download.js` | Missing env var handled | MEDIUM |
| `app.js` | Wallet not installed shows CTA | HIGH |
| `app.js` | User rejects connection | MEDIUM |
| `app.js` | Network switch required | MEDIUM |
| `app.js` | User rejects signature | MEDIUM |
| `app.js` | Insufficient balance handled | HIGH |
| `app.js` | Payment verification timeout | HIGH |
| `app.js` | Successful purchase triggers download | CRITICAL |
| `app.js` | Page refresh during purchase | MEDIUM |

#### E2E Tests Needed

| Flow | Test Case | Priority |
|------|-----------|----------|
| Full purchase | New user, no wallet → install → connect → buy | CRITICAL |
| Full purchase | Existing user, wrong network → switch → buy | HIGH |
| Full purchase | Existing user, correct network → buy | CRITICAL |
| Error recovery | Facilitator down → retry → success | MEDIUM |
| Error recovery | Signature rejected → retry → success | MEDIUM |
| Mobile | Complete flow on MetaMask mobile browser | HIGH |
| Mobile | Complete flow on iOS Safari + WalletConnect | MEDIUM |

#### Integration Tests Needed

| Integration | Test Case | Priority |
|-------------|-----------|----------|
| Coinbase Facilitator | Verify endpoint returns valid | CRITICAL |
| Coinbase Facilitator | Settle endpoint captures payment | CRITICAL |
| MetaMask | `eth_requestAccounts` flow | HIGH |
| MetaMask | `wallet_switchEthereumChain` flow | HIGH |
| Base RPC | USDC balance query | MEDIUM |

---

## 📋 RECOMMENDED TEST CASES

### Manual Test Checklist

```
□ No Wallet Scenario
  1. Open site in incognito without MetaMask
  2. Click "Connect Wallet"
  3. Verify helpful install CTA appears
  4. Verify no console errors

□ Wrong Network Scenario
  1. Connect wallet on Ethereum mainnet
  2. Click "Buy Soul"
  3. Verify "Switching to Base..." message
  4. Verify MetaMask shows switch prompt
  5. Confirm switch
  6. Verify flow continues

□ Payment Rejection Scenario
  1. Connect wallet on Base
  2. Click "Buy Soul"
  3. When MetaMask appears, click Reject
  4. Verify "Payment cancelled" (not error) toast
  5. Verify can retry immediately

□ Network Timeout Scenario
  1. Connect wallet on Base
  2. Block facilitator URL in DevTools
  3. Click "Buy Soul" and sign
  4. Verify timeout message after 10s
  5. Verify "Try Again" button works

□ Page Refresh Scenario
  1. Start purchase, get to signing step
  2. Refresh page
  3. Verify connection persists
  4. Verify can restart purchase

□ Mobile Scenario
  1. Open on iPhone Safari
  2. Verify layout is usable
  3. Verify navigation accessible
  4. Test with MetaMask app

□ Security - Replay Attack
  1. Complete purchase, capture network request
  2. Replay the same request with same signature
  3. Verify 402 response (not content)
```

---

## 📊 OVERALL QUALITY ASSESSMENT

### Score: 6.5/10 (Acceptable with issues)

| Category | Score | Notes |
|----------|-------|-------|
| Functionality | 6/10 | Core flow works but missing critical security features (nonce replay) |
| Error Handling | 5/10 | Basic coverage, many gaps in edge cases |
| UX | 7/10 | Clean UI but confusing error messages and missing feedback |
| Security | 5/10 | Replay vulnerability, no input validation, hardcoded fallback |
| Performance | 7/10 | No major issues, but missing timeouts |
| Accessibility | 4/10 | Missing ARIA, contrast issues |
| Browser Support | 6/10 | Modern browsers only, wallet injection issues |
| Responsive | 6/10 | Basic mobile support but nav hidden, touch targets small |
| Testability | 3/10 | No tests written, tightly coupled code |

### Strengths
- Clean, modern UI design
- Good use of CSS custom properties
- Proper CORS handling in API
- x402 protocol implementation follows spec
- Toast notification system is user-friendly

### Weaknesses
- **Critical security vulnerability:** Nonce replay protection missing
- Poor error messages confuse users
- No test coverage
- Mobile navigation completely hidden
- Missing wallet compatibility checks
- No timeout handling on external calls

### Blockers for Production
1. **Fix nonce replay vulnerability** - Users could download without paying
2. **Add settlement verification** - Don't return content until payment settled
3. **Add token approval flow** - First-time users can't pay
4. **Fix mobile navigation** - Users can't browse on mobile
5. **Add proper error handling** - Distinguish user cancellation from errors

---

## 🎯 PRIORITY FIXES

### Must Fix (Before Launch)
- [ ] Add nonce uniqueness validation in API
- [ ] Await settlement or verify before returning content
- [ ] Add USDC approval flow in frontend
- [ ] Add `chainChanged` handler
- [ ] Fix mobile navigation (don't hide all links)

### Should Fix (Week 1)
- [ ] Add timeouts to all fetch calls
- [ ] Distinguish user rejection from errors
- [ ] Add balance check before purchase
- [ ] Wrap atob/btoa in try/catch
- [ ] Fix "Expected 402" error message

### Nice to Have (Month 1)
- [ ] Add transaction status polling
- [ ] Improve accessibility (ARIA labels)
- [ ] Add E2E test suite
- [ ] Support WalletConnect
- [ ] Add rate limiting

---

**Report generated by QA Agent**  
**Methodology:** Static code analysis + scenario modeling + x402 spec compliance check
