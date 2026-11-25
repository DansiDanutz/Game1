/** The few Stripe calls the game needs, without a library. */
const VERSION = '2025-09-30.clover';

export function stripeClient(key, fetchFn = fetch) {
  return async (method, path, params = {}, idempotencyKey) => {
    const form = new URLSearchParams(params).toString();
    const isRead = method === 'GET';
    const res = await fetchFn(`https://api.stripe.com/v1/${path}${isRead && form ? `?${form}` : ''}`, {
      method,
      headers: {
        authorization: `Bearer ${key}`, 'stripe-version': VERSION,
        'content-type': 'application/x-www-form-urlencoded',
        ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
      },
      ...(isRead ? {} : { body: form }),
    });
    if (!res.ok) throw new Error(`Stripe answered ${res.status} to ${method} ${path}`);
    return res.json();
  };
}

const TOLERANCE_SECONDS = 300;

async function hmacHex(secret, text) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(text)));
  return [...mac].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function sameText(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function isSigned(body, header, secret, now) {
  const parts = (header || '').split(',').map((part) => part.split('='));
  const time = parts.find(([k]) => k === 't')?.[1];
  if (!/^\d+$/.test(time || '') || Math.abs(now.getTime() / 1000 - Number(time)) > TOLERANCE_SECONDS) return false;
  const expected = await hmacHex(secret, `${time}.${body}`);
  return parts.some(([k, v]) => k === 'v1' && sameText(v || '', expected));
}
