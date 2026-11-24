/**
 * Checkout, cancel and card page. The buyer comes from the sign-in, and the
 * price from the settings. Nothing the browser sends picks either.
 */
const OPEN = new Set(['active', 'trialing', 'past_due', 'unpaid', 'incomplete']);

async function customerFor(user, account, { stripe, rpc }) {
  if (account.stripe_customer_id) return account.stripe_customer_id;
  const customer = await stripe('POST', 'customers',
    { email: user.email || '', 'metadata[app]': 'shikaku', 'metadata[user_id]': user.id }, `shikaku-customer-${user.id}`);
  await rpc('shikaku_save_customer', { p_user: user.id, p_customer: customer.id });
  return customer.id;
}

async function checkout(user, account, deps) {
  const taken = [409, { error: 'You already have a plan. If you just paid, it can take a minute to appear.' }];
  if (account.open_subscription_id) return taken;
  const customer = await customerFor(user, account, deps);
  const { priceId, siteUrl } = deps.config;
  const plans = (await deps.stripe('GET', 'subscriptions', { customer, status: 'all', limit: '100' }))
    .data.filter((plan) => plan.metadata?.app === 'shikaku');
  if (plans.some((plan) => OPEN.has(plan.status))) return taken;
  const open = await deps.stripe('GET', 'checkout/sessions', { customer, status: 'open', limit: '10' });
  const existing = open.data.find((s) => s.metadata?.app === 'shikaku' && s.metadata.price === priceId && s.url);
  if (existing) return [200, { url: existing.url }];
  const session = await deps.stripe('POST', 'checkout/sessions', {
    mode: 'subscription', customer,
    'line_items[0][price]': priceId, 'line_items[0][quantity]': '1',
    'metadata[app]': 'shikaku', 'metadata[price]': priceId,
    'subscription_data[metadata][app]': 'shikaku', 'subscription_data[metadata][user_id]': user.id,
    success_url: `${siteUrl}/?subscribed=1`, cancel_url: `${siteUrl}/`,
    // Two tabs at once get the same checkout; the day and last plan make it new again.
  }, `shikaku-checkout-${user.id}-${priceId}-${plans[0]?.id ?? 'first'}-${deps.now().toISOString().slice(0, 10)}`);
  return session.status && session.status !== 'open' ? taken : [200, { url: session.url }];
}

async function cancel(user, account, { stripe }) {
  const id = account.open_subscription_id;
  if (!id) return [404, { error: 'You have no plan to cancel.' }];
  const plan = await stripe('GET', `subscriptions/${id}`);
  if (plan.status === 'past_due' || plan.status === 'unpaid') {
    await stripe('DELETE', `subscriptions/${id}`);
    return [200, { ended: true }];
  }
  await stripe('POST', `subscriptions/${id}`, { cancel_at_period_end: 'true' });
  return [200, { ended: false }];
}

async function portal(user, account, { stripe, config }) {
  if (!account.stripe_customer_id) return [404, { error: 'You have no payments yet.' }];
  const session = await stripe('POST', 'billing_portal/sessions', { customer: account.stripe_customer_id, return_url: `${config.siteUrl}/` });
  return [200, { url: session.url }];
}

const ACTIONS = new Map([['checkout', checkout], ['cancel', cancel], ['portal', portal]]);

async function answer(req, deps) {
  if (req.method !== 'POST') return [405, { error: 'Use POST.' }];
  let action;
  try { action = ACTIONS.get((await req.json())?.action); } catch { action = undefined; }
  if (!action) return [400, { error: 'Unknown request.' }];
  const user = await deps.getUser(req.headers.get('authorization'));
  if (!user) return [401, { error: 'Sign in with your email first.' }];
  const [account] = await deps.rpc('shikaku_billing_account', { p_user: user.id });
  if (!account?.linked) return [403, { error: 'Link your email to your player name first.' }];
  return action(user, account, deps);
}

export async function handleBilling(req, deps) {
  const headers = {
    'access-control-allow-origin': new URL(deps.config.siteUrl).origin, vary: 'origin',
    'access-control-allow-headers': 'authorization, apikey, content-type, x-client-info',
    'access-control-allow-methods': 'POST, OPTIONS',
  };
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  let status, body;
  try {
    [status, body] = await answer(req, deps);
  } catch (error) {
    deps.log?.('billing failed', error);
    [status, body] = [502, { error: 'Payments are not available right now. Please try again.' }];
  }
  return new Response(JSON.stringify(body), { status, headers: { ...headers, 'content-type': 'application/json' } });
}
