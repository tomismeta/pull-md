# SoulStarter Security Audit Report

**Date:** 2026-02-11  
**Auditor:** Security Agent  
**Scope:** x402-powered agent memory marketplace  
**Files Audited:**
- `/api/souls/[id]/download.js`
- `/public/js/app.js`
- `/public/index.html`
- `/public/soul.html`
- `/vercel.json`

---

## Executive Summary

| Category | Rating |
|----------|--------|
| **Overall Security Posture** | ⚠️ MODERATE RISK |
| **Payment Security** | ✅ ACCEPTABLE |
| **API Security** | ⚠️ REQUIRES ATTENTION |
| **Client-Side Security** | ⚠️ REQUIRES ATTENTION |
| **Infrastructure** | ⚠️ REQUIRES ATTENTION |

**Critical Finding:** The application handles real monetary transactions but lacks several key security controls including replay attack protection, rate limiting, and proper CORS configuration.

---

## Findings by Severity

### 🔴 CRITICAL

#### CORS-001: Wildcard CORS Policy
**File:** `api/souls/[id]/download.js` (Line 6)

```javascript
res.setHeader('Access-Control-Allow-Origin', '*');
```

**Issue:** The API endpoint allows cross-origin requests from **any domain**. This enables:
- Malicious websites to embed and exploit the payment endpoint
- CSRF-style attacks from unauthorized domains
- Potential clickjacking combined with payment extraction

**Risk:** High - Any website can call this API on behalf of users

**Fix:**
```javascript
const allowedOrigins = ['https://soulstarter.vercel.app', 'https://soulstarter.io'];
const origin = req.headers.origin;
if (allowedOrigins.includes(origin)) {
  res.setHeader('Access-Control-Allow-Origin', origin);
}
```

---

#### AUTH-001: Missing Replay Attack Protection
**File:** `api/souls/[id]/download.js` (Lines 48-52)

**Issue:** While nonces are generated for payment requirements, there is **no server-side nonce tracking**. An attacker could:
1. Capture a valid payment signature
2. Replay it indefinitely to download the soul multiple times
3. Share the signature with others for unauthorized access

```javascript
// Nonce is generated but NEVER stored or verified
nonce: Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15)
```

**Risk:** Critical - Payment bypass through signature replay

**Fix:** Implement nonce tracking:
```javascript
// Use Redis or database for production
const usedNonces = new Set(); // In-memory for MVP only

// During verification:
if (usedNonces.has(paymentPayload.payload.nonce)) {
  return res.status(400).json({ error: 'Payment already used' });
}
usedNonces.add(paymentPayload.payload.nonce);
```

---

### 🟠 HIGH

#### RATE-001: Missing Rate Limiting
**File:** `api/souls/[id]/download.js`

**Issue:** No rate limiting on the download endpoint. Attackers can:
- DDoS the facilitator verification service
- Spam payment attempts to enumerate valid IDs
- Exhaust server resources

**Risk:** High - Service availability and cost exposure

**Fix:** Implement rate limiting (Vercel Edge Config or middleware):
```javascript
// Using simple in-memory (reset on deploy - use Redis for production)
const rateLimits = new Map();

function checkRateLimit(ip) {
  const now = Date.now();
  const windowMs = 60 * 1000; // 1 minute
  const maxRequests = 10;
  
  const userLimit = rateLimits.get(ip) || { count: 0, resetTime: now + windowMs };
  
  if (now > userLimit.resetTime) {
    userLimit.count = 0;
    userLimit.resetTime = now + windowMs;
  }
  
  userLimit.count++;
  rateLimits.set(ip, userLimit);
  
  return userLimit.count <= maxRequests;
}
```

---

#### XSS-001: Client-Side DOM Injection
**File:** `public/js/app.js` (Lines 189-197, 226-235)

**Issue:** Direct `innerHTML` assignment with unsanitized data:

```javascript
// Line 226 - Transaction hash from external source
txHashEl.innerHTML = `Transaction: <a href="https://basescan.org/tx/${txHash}"...`;

// Line 189 - Toast message injection
toast.textContent = message; // This one is safe (textContent)
// BUT loadSouls() uses innerHTML with template literals
```

**Risk:** High - Potential XSS if txHash or other data is compromised

**Fix:**
```javascript
// Use textContent for user data, construct elements safely
const link = document.createElement('a');
link.href = `https://basescan.org/tx/${encodeURIComponent(txHash)}`;
link.textContent = `${txHash.slice(0, 10)}...${txHash.slice(-8)}`;
link.target = '_blank';
link.style.color = 'var(--accent-secondary)';
txHashEl.textContent = 'Transaction: ';
txHashEl.appendChild(link);
```

---

#### PAY-001: Fire-and-Forget Settlement
**File:** `api/souls/[id]/download.js` (Lines 94-104)

**Issue:** Settlement is done asynchronously without `await` or proper error handling:

```javascript
// Settle payment asynchronously (don't block response)
fetch(`${CONFIG.facilitator}/settle`, {...}).catch(console.error);
// ^ Content is returned BEFORE settlement completes
```

**Risk:** High - Content delivered before payment is settled. Network failures could result in:
- User gets content but payment never settles
- Double-spend scenarios
- Lost revenue

**Fix:** Either await settlement or implement webhook confirmation:
```javascript
// Option 1: Await settlement (slower but safer)
const settleResponse = await fetch(`${CONFIG.facilitator}/settle`, {...});
if (!settleResponse.ok) {
  return res.status(500).json({ error: 'Payment settlement failed' });
}

// Option 2: Implement webhook for async confirmation
// Return pending state, confirm via webhook callback
```

---

### 🟡 MEDIUM

#### SEC-001: Hardcoded Fallback Seller Address
**File:** `api/souls/[id]/download.js` (Line 24)

```javascript
sellerAddress: process.env.SELLER_ADDRESS || '0xd5837ea218116aD34A19eF86eC77D3d328c20195'
```

**Issue:** Fallback address embedded in code. If env var is not set:
- Payments go to hardcoded address
- Potential for misconfiguration attack

**Risk:** Medium - Revenue misdirection

**Fix:** Remove fallback, fail loudly:
```javascript
sellerAddress: process.env.SELLER_ADDRESS || (() => {
  throw new Error('SELLER_ADDRESS environment variable required');
})()
```

---

#### INJ-001: Limited Input Validation
**File:** `api/souls/[id]/download.js` (Line 75)

**Issue:** Payment signature is base64 decoded without length limits:

```javascript
const paymentPayload = JSON.parse(Buffer.from(paymentSignature, 'base64').toString());
```

**Risk:** Medium - Potential for:
- Memory exhaustion from huge payloads
- JSON bomb attacks
- Stack overflow from deeply nested objects

**Fix:**
```javascript
// Limit payload size
const MAX_PAYLOAD_SIZE = 10000; // 10KB
const rawPayload = Buffer.from(paymentSignature, 'base64');
if (rawPayload.length > MAX_PAYLOAD_SIZE) {
  return res.status(400).json({ error: 'Payload too large' });
}
```

---

#### INFO-001: Information Leakage in Errors
**File:** `api/souls/[id]/download.js` (Lines 125-129)

```javascript
console.error(`Soul content not found for ${id}`);
return res.status(500).json({ error: 'Soul content unavailable' });
```

**Issue:** Error messages reveal system internals:
- "Soul content unavailable" suggests environment variable issues
- Console logs expose internal paths/structure

**Risk:** Low-Medium - Information disclosure aids reconnaissance

**Fix:**
```javascript
// Log internally, return generic message
console.error('Soul fetch error:', { id, error: err.message });
return res.status(500).json({ error: 'Service temporarily unavailable' });
```

---

#### HEAD-001: Missing Security Headers
**Files:** All HTML files

**Issue:** No Content Security Policy (CSP) or security headers:
- No protection against XSS via inline scripts
- No frame protection (clickjacking)
- No HTTPS enforcement

**Risk:** Medium - Various injection and framing attacks

**Fix (via vercel.json or middleware):**
```json
{
  "headers": [
    {
      "source": "/(.*)",
      "headers": [
        { "key": "Content-Security-Policy", "value": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; connect-src 'self' https://api.cdp.coinbase.com;" },
        { "key": "X-Frame-Options", "value": "DENY" },
        { "key": "X-Content-Type-Options", "value": "nosniff" },
        { "key": "Referrer-Policy", "value": "strict-origin-when-cross-origin" }
      ]
    }
  ]
}
```

---

### 🟢 LOW

#### UI-001: Client-Side Price Display
**File:** `public/soul.html` (Line 76), `public/js/app.js` (Line 159)

**Issue:** Price displayed in client HTML can be manipulated. While the server validates the actual payment amount, users could be confused by UI manipulation.

**Risk:** Low - UI confusion only (server validates real payment)

**Fix:** Fetch price from server or display server-validated price prominently after purchase.

---

#### DEP-001: Inline Event Handlers
**Files:** `public/index.html`, `public/soul.html`

**Issue:** Multiple `onclick="function()"` handlers. While not exploitable directly, they:
- Violate CSP best practices (require 'unsafe-inline')
- Make XSS slightly easier if content injection occurs

**Risk:** Low - Defense in depth

**Fix:** Move to external JS:
```javascript
document.getElementById('walletBtn').addEventListener('click', connectWallet);
```

---

#### TIME-001: Timestamp Not Validated
**File:** `api/souls/[id]/download.js` (Line 50)

**Issue:** Payment requirements include timestamp but it's not validated:
```javascript
timestamp: Date.now(), // Never checked during verification
```

**Risk:** Low - Old payment requirements could be reused

**Fix:** Validate timestamp is recent (within 5 minutes):
```javascript
const timestamp = paymentPayload.payload.timestamp;
if (Date.now() - timestamp > 5 * 60 * 1000) {
  return res.status(400).json({ error: 'Payment expired' });
}
```

---

## Positive Security Findings

✅ **Environment Variable Usage**: Secrets properly stored in env vars (`SOUL_META_STARTER_V1`, `SELLER_ADDRESS`)

✅ **No Hardcoded API Keys**: No API keys, private keys, or credentials in client-side code

✅ **Coinbase Facilitator**: Uses official facilitator for payment verification (not DIY crypto)

✅ **ID Whitelisting**: Soul IDs validated against whitelist (`validSouls` array)

✅ **HTTPS by Default**: Vercel deployment uses HTTPS

✅ **No SQL Injection**: No database queries (serverless architecture)

---

## Recommendations Summary

### Immediate (Deploy Before Production)

1. **Implement replay protection** using Redis/Vercel KV for nonce tracking
2. **Restrict CORS** to specific origins only
3. **Add rate limiting** to prevent abuse
4. **Fix settlement flow** - either await settlement or implement webhook confirmation
5. **Sanitize DOM output** in app.js to prevent XSS

### Short-term (Within 1 Week)

6. Add security headers (CSP, X-Frame-Options)
7. Remove hardcoded fallback seller address
8. Add input size limits on payment payloads
9. Implement timestamp validation on payments

### Long-term (Enhancement)

10. Add webhook endpoint for async settlement confirmation
11. Implement proper logging/monitoring for security events
12. Add request signing for webhook verification
13. Consider implementing proof-of-payment tokens for re-downloads

---

## Attack Scenarios

### Scenario 1: Signature Replay Attack
1. Attacker purchases soul legitimately
2. Attacker captures `PAYMENT-SIGNATURE` header
3. Attacker replays same signature to `/api/souls/[id]/download`
4. **Result**: Unlimited free downloads using one payment

### Scenario 2: CORS Abuse
1. Attacker creates malicious website `evil.com`
2. Victim visits `evil.com` while having valid payment signature
3. `evil.com` makes cross-origin request to download endpoint
4. **Result**: Soul content exfiltrated to attacker's domain

### Scenario 3: Settlement Failure
1. User makes payment, signature verified
2. Network error occurs during settlement
3. User receives content, settlement never completes
4. **Result**: User gets content for free (or double-spend scenario)

---

## Compliance Notes

- **PCI DSS**: Not applicable (payments handled by Coinbase)
- **GDPR**: Ensure soul content doesn't contain PII
- **SOC 2**: Document security controls for audit

---

## Conclusion

The SoulStarter codebase demonstrates **good fundamental security practices** with proper environment variable usage and payment verification via Coinbase's facilitator. However, **critical vulnerabilities exist** around replay attacks and CORS configuration that must be addressed before handling production traffic with real funds.

**Recommendation**: Fix CRITICAL and HIGH severity issues before launching. The application should not handle real money until replay protection and rate limiting are implemented.

---

*Report generated by Security Agent for SoulStarter project*
*Review date: 2026-02-11*
