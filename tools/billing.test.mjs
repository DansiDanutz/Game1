/* Stripe functions with Stripe and the database faked (run: node --test tools/billing.test.mjs). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { handleBilling } from '../supabase/functions/_shared/billing.mjs';
import { handleWebhook } from '../supabase/functions/_shared/webhook.mjs';
import { readConfig } from '../supabase/functions/_shared/config.mjs';
import { stripeClient } from '../supabase/functions/_shared/stripe.mjs';

const ENV = {
  STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: 'whsec_test', SHIKAKU_PRICE_ID: 'price_1',
  SHIKAKU_SITE_URL: 'https://game.test', SUPABASE_URL: 'https://db.test',
  SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'service',
};
const config = readConfig(ENV);
const USER = { id: 'user-1', email: 'ann@example.test' };

/* ------------------------------------------------------------- billing ---- */
function billingDeps(over = {}) {
  const calls = [];
  const account = { linked: true, stripe_customer_id: 'cus_1', open_subscription_id: null, ...over.account };
  return {
    calls, config, now: () => new Date('2026-11-25T10:00:00Z'),
    getUser: async () => ('user' in over ? over.user : USER),
    rpc: async (fn, args) => {
      calls.push([fn, args]);
      if (fn === 'shikaku_billing_account') return [account];
      return null;
    },
    stripe: async (method, path, params, key) => {
      calls.push([method, path, params, key]);
      if (over.stripe) { const r = over.stripe(method, path, params); if (r !== undefined) return r; }
      if (method === 'GET' && path === 'checkout/sessions') return { data: [] };
      if (path === 'customers') return { id: 'cus_new' };
      if (path === 'checkout/sessions') return { id: 'cs_1', url: 'https://checkout.stripe.com/cs_1' };
      if (path === 'billing_portal/sessions') return { url: 'https://billing.stripe.com/p' };
      return { id: path.split('/')[1], cancel_at_period_end: true, status: 'active' };
    },
  };
}
const ask = (deps, action, init = {}) => handleBilling(new Request('https://fn.test', {
  method: 'POST', headers: { authorization: 'Bearer jwt', origin: 'https://game.test', ...init.headers },
  body: init.body ?? JSON.stringify({ action }),
}), deps);
const stripeCall = (deps, method, path) => deps.calls.find((c) => c[0] === method && c[1] === path);

test('checkout sells the configured price to the signed-in customer', async () => {
  const deps = billingDeps();
  const res = await ask(deps, 'checkout');
  assert.equal(res.status, 200);
  assert.equal((await res.json()).url, 'https://checkout.stripe.com/cs_1');
  const params = stripeCall(deps, 'POST', 'checkout/sessions')[2];
  assert.equal(params.mode, 'subscription');
  assert.equal(params.customer, 'cus_1');
  assert.equal(params['line_items[0][price]'], 'price_1');
  assert.equal(params['subscription_data[metadata][app]'], 'shikaku');
  assert.equal(params['subscription_data[metadata][user_id]'], 'user-1');
  assert.ok(params.success_url.startsWith('https://game.test/'));
});
test('a price, customer or user sent by the browser is ignored', async () => {
  const deps = billingDeps();
  await ask(deps, 'checkout', { body: JSON.stringify({ action: 'checkout', price: 'price_evil', customer: 'cus_evil', user_id: 'x' }) });
  assert.ok(!JSON.stringify(deps.calls).includes('evil'));
});
test('a second plan is refused', async () => {
  const deps = billingDeps({ account: { open_subscription_id: 'sub_1' } });
  assert.equal((await ask(deps, 'checkout')).status, 409);
  assert.equal(stripeCall(deps, 'POST', 'checkout/sessions'), undefined);
});
test('a second tab gets the checkout that is already open', async () => {
  const deps = billingDeps({ stripe: (m, p) => (m === 'GET' && p === 'checkout/sessions' ? { data: [{ url: 'https://checkout.stripe.com/open', metadata: { app: 'shikaku' } }] } : undefined) });
  assert.equal((await (await ask(deps, 'checkout')).json()).url, 'https://checkout.stripe.com/open');
  assert.equal(stripeCall(deps, 'POST', 'checkout/sessions'), undefined);
});
test('two checkouts at the same moment share one idempotency key', async () => {
  const a = billingDeps(), b = billingDeps();
  await ask(a, 'checkout'); await ask(b, 'checkout');
  const key = stripeCall(a, 'POST', 'checkout/sessions')[3];
  assert.ok(key); assert.equal(key, stripeCall(b, 'POST', 'checkout/sessions')[3]);
});
test('a first-time buyer gets one customer, stored for later', async () => {
  const deps = billingDeps({ account: { stripe_customer_id: null } });
  await ask(deps, 'checkout');
  assert.ok(stripeCall(deps, 'POST', 'customers')[3]);
  assert.ok(deps.calls.some((c) => c[0] === 'shikaku_save_customer' && c[1].p_customer === 'cus_new'));
});
test('cancelling keeps the paid month, and only touches the caller\'s own plan', async () => {
  const deps = billingDeps({ account: { open_subscription_id: 'sub_1' } });
  assert.equal((await ask(deps, 'cancel')).status, 200);
  assert.deepEqual(stripeCall(deps, 'POST', 'subscriptions/sub_1')[2], { cancel_at_period_end: 'true' });
  assert.equal((await ask(billingDeps(), 'cancel')).status, 404);
});
test('a plan whose payment is failing is ended at once', async () => {
  const deps = billingDeps({ account: { open_subscription_id: 'sub_1' }, stripe: (m) => (m === 'GET' ? { id: 'sub_1', status: 'past_due' } : undefined) });
  await ask(deps, 'cancel');
  assert.ok(stripeCall(deps, 'DELETE', 'subscriptions/sub_1'));
});
test('the card page opens for the caller\'s own customer', async () => {
  const deps = billingDeps();
  assert.equal((await ask(deps, 'portal')).status, 200);
  assert.equal(stripeCall(deps, 'POST', 'billing_portal/sessions')[2].customer, 'cus_1');
  assert.equal((await ask(billingDeps({ account: { stripe_customer_id: null } }), 'portal')).status, 404);
});
test('signed-out, unlinked, unknown and malformed requests are refused', async () => {
  assert.equal((await ask(billingDeps({ user: null }), 'checkout')).status, 401);
  assert.equal((await ask(billingDeps({ account: { linked: false } }), 'checkout')).status, 403);
  assert.equal((await ask(billingDeps(), 'refund')).status, 400);
  assert.equal((await ask(billingDeps(), 'checkout', { body: '{' })).status, 400);
  const get = await handleBilling(new Request('https://fn.test'), billingDeps());
  assert.equal(get.status, 405);
});
test('only the game\'s own site is allowed by the browser rules', async () => {
  const ok = await ask(billingDeps(), 'checkout');
  assert.equal(ok.headers.get('access-control-allow-origin'), 'https://game.test');
  const pre = await handleBilling(new Request('https://fn.test', { method: 'OPTIONS' }), billingDeps());
  assert.equal(pre.status, 204);
});
test('a Stripe failure shows no internal details', async () => {
  const deps = billingDeps({ stripe: () => { throw new Error('sk_test_x leaked'); } });
  const res = await ask(deps, 'checkout');
  assert.equal(res.status, 502);
  assert.ok(!(await res.text()).includes('sk_test'));
});

/* ------------------------------------------------------------- webhook ---- */
const SUB = { id: 'sub_1', customer: 'cus_1', status: 'active', cancel_at_period_end: false,
  metadata: { app: 'shikaku', user_id: 'user-1' },
  items: { data: [{ price: { id: 'price_1', metadata: { play_credits: '100' } }, quantity: 1, current_period_end: 1798000000 }] } };
const INVOICE = { id: 'in_1', amount_paid: 499, billing_reason: 'subscription_create',
  parent: { subscription_details: { subscription: 'sub_1' } } };
const CHARGE = { id: 'ch_1', customer: 'cus_1', payment_intent: 'pi_1', amount: 499, amount_refunded: 0 };
function hookDeps(over = {}) {
  const calls = [];
  return {
    calls, config, now: () => new Date('2026-11-25T10:00:00Z'), log: () => {},
    rpc: async (fn, args) => {
      calls.push([fn, args]);
      if (over.rpc) { const r = over.rpc(fn, args); if (r !== undefined) return r; }
      if (fn === 'shikaku_set_clawback') return true;
      if (fn === 'shikaku_customer_user') return args.p_customer === 'cus_1' ? 'user-1' : null;
      return null;
    },
    stripe: async (method, path) => {
      if (over.stripe && path in over.stripe) return over.stripe[path];
      if (path === 'subscriptions/sub_1') return SUB;
      if (path === 'charges/ch_1') return CHARGE;
      if (path === 'invoice_payments') return { data: [{ invoice: 'in_1' }] };
      if (path === 'invoices/in_1') return INVOICE;
      throw new Error('unexpected ' + path);
    },
  };
}
function send(deps, type, object, { at = deps.now(), secret = 'whsec_test', tamper = '' } = {}) {
  const body = JSON.stringify({ id: 'evt_1', type, livemode: false, data: { object } });
  const t = Math.floor(at.getTime() / 1000);
  const v1 = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
  return handleWebhook(new Request('https://fn.test', { method: 'POST', body: body + tamper,
    headers: { 'stripe-signature': `t=${t},v1=${v1}` } }), deps);
}
const did = (deps, fn) => deps.calls.filter((c) => c[0] === fn).map((c) => c[1]);

test('a paid month grants the price\'s credits under its invoice', async () => {
  const deps = hookDeps();
  assert.equal((await send(deps, 'invoice.paid', INVOICE)).status, 200);
  assert.deepEqual(did(deps, 'shikaku_grant_credits'), [{ p_invoice: 'in_1', p_user: 'user-1', p_credits: 100 }]);
});
test('free, prorated and one-off invoices grant nothing', async () => {
  for (const change of [{ amount_paid: 0 }, { billing_reason: 'subscription_update' }, { parent: null }]) {
    const deps = hookDeps();
    assert.equal((await send(deps, 'invoice.paid', { ...INVOICE, ...change })).status, 200);
    assert.equal(did(deps, 'shikaku_grant_credits').length, 0);
  }
});
test('other products and other prices on the account are ignored', async () => {
  for (const sub of [{ ...SUB, metadata: {} }, { ...SUB, items: { data: [{ price: { id: 'price_other' } }] } }]) {
    const deps = hookDeps({ stripe: { 'subscriptions/sub_1': sub } });
    assert.equal((await send(deps, 'invoice.paid', INVOICE)).status, 200);
    assert.equal(did(deps, 'shikaku_grant_credits').length, 0);
  }
});
test('a user id that does not own the customer is not trusted', async () => {
  const deps = hookDeps({ stripe: { 'subscriptions/sub_1': { ...SUB, metadata: { app: 'shikaku', user_id: 'user-2' } } } });
  await send(deps, 'invoice.paid', INVOICE);
  assert.equal(did(deps, 'shikaku_grant_credits').length, 0);
});
test('plan changes store what Stripe says now, not what the event said', async () => {
  const deps = hookDeps({ stripe: { 'subscriptions/sub_1': { ...SUB, status: 'past_due' } } });
  await send(deps, 'customer.subscription.updated', { ...SUB, status: 'active' });
  assert.equal(did(deps, 'shikaku_save_subscription')[0].p_status, 'past_due');
});
test('a partial refund takes back its share, rounded in the buyer\'s favour', async () => {
  const deps = hookDeps({ stripe: { 'charges/ch_1': { ...CHARGE, amount_refunded: 250 } } });
  await send(deps, 'charge.refunded', CHARGE);
  const [c] = did(deps, 'shikaku_set_clawback');
  assert.deepEqual([c.p_invoice, c.p_source, c.p_credits], ['in_1', 'refund', 50]);
});
test('a failed refund gives the credits back', async () => {
  const deps = hookDeps();
  await send(deps, 'refund.failed', { charge: 'ch_1' });
  assert.equal(did(deps, 'shikaku_set_clawback')[0].p_credits, 0);
});
test('a dispute takes back what Stripe withdrew, and returns it when won', async () => {
  for (const [txns, expected] of [[[-499], 100], [[-499, 499], 0], [[], 0]]) {
    const deps = hookDeps({ stripe: { 'disputes/dp_1': { id: 'dp_1', charge: 'ch_1', amount: 499, balance_transactions: txns.map((amount) => ({ amount })) } } });
    await send(deps, 'charge.dispute.funds_withdrawn', { id: 'dp_1', charge: 'ch_1' });
    const [c] = did(deps, 'shikaku_set_clawback');
    assert.deepEqual([c.p_source, c.p_credits], ['dispute', expected]);
  }
});
test('a refund before its credits were granted is retried', async () => {
  const deps = hookDeps({ rpc: (fn) => (fn === 'shikaku_set_clawback' ? false : undefined) });
  assert.equal((await send(deps, 'charge.refunded', CHARGE)).status, 500);
});
test('a refund of something that never granted credits is accepted', async () => {
  const deps = hookDeps({ rpc: (fn) => (fn === 'shikaku_set_clawback' ? false : undefined),
    stripe: { 'invoices/in_1': { ...INVOICE, billing_reason: 'subscription_update' } } });
  assert.equal((await send(deps, 'charge.refunded', CHARGE)).status, 200);
});
test('refunds for other products are ignored', async () => {
  for (const charge of [{ ...CHARGE, customer: 'cus_other' }, { ...CHARGE, customer: null }, { ...CHARGE, payment_intent: null }]) {
    const deps = hookDeps({ stripe: { 'charges/ch_1': charge } });
    assert.equal((await send(deps, 'charge.refunded', CHARGE)).status, 200);
    assert.equal(did(deps, 'shikaku_set_clawback').length, 0);
  }
});
test('forged, altered, old and unsigned events are refused', async () => {
  const deps = hookDeps();
  assert.equal((await send(deps, 'invoice.paid', INVOICE, { secret: 'whsec_wrong' })).status, 400);
  assert.equal((await send(deps, 'invoice.paid', INVOICE, { tamper: ' ' })).status, 400);
  assert.equal((await send(deps, 'invoice.paid', INVOICE, { at: new Date('2026-11-25T09:50:00Z') })).status, 400);
  assert.equal((await handleWebhook(new Request('https://fn.test', { method: 'POST', body: '{}' }), deps)).status, 400);
  assert.equal(deps.calls.length, 0);
});
test('a database failure makes Stripe try again', async () => {
  const deps = hookDeps({ rpc: () => { throw new Error('down'); } });
  assert.equal((await send(deps, 'invoice.paid', INVOICE)).status, 500);
});

/* -------------------------------------------------------------- config ---- */
test('a live Stripe key is refused until live payments are switched on', () => {
  assert.throws(() => readConfig({ ...ENV, STRIPE_SECRET_KEY: 'sk_live_x' }), /live/i);
  assert.ok(readConfig({ ...ENV, STRIPE_SECRET_KEY: 'sk_live_x', SHIKAKU_LIVE_PAYMENTS: 'approved' }));
});
test('missing settings are named, never their values', () => {
  assert.throws(() => readConfig({ ...ENV, SHIKAKU_PRICE_ID: '' }), (e) => /SHIKAKU_PRICE_ID/.test(e.message) && !e.message.includes('sk_test'));
});
test('the Stripe client pins its version and hides errors\' secrets', async () => {
  let seen;
  const ok = stripeClient('sk_test_x', async (url, init) => { seen = { url, init }; return new Response('{"id":"a"}'); });
  await ok('POST', 'customers', { 'metadata[a]': 'b' }, 'key-1');
  assert.equal(seen.url, 'https://api.stripe.com/v1/customers');
  assert.equal(seen.init.body, 'metadata%5Ba%5D=b');
  assert.equal(seen.init.headers['idempotency-key'], 'key-1');
  assert.ok(seen.init.headers['stripe-version']);
  const bad = stripeClient('sk_test_x', async () => new Response('{"error":{"code":"x"}}', { status: 402 }));
  await assert.rejects(bad('GET', 'customers', { limit: '1' }), (e) => /402/.test(e.message) && !e.message.includes('sk_test'));
});
