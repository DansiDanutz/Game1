/**
 * Checkout, cancel and card page. The buyer comes from the sign-in, and the
 * price from the settings. Nothing the browser sends picks either.
 */
const KEY_WINDOW_MS = 30 * 60 * 1000;

async function customerFor(user, account, { stripe, rpc }) {
  if (account.stripe_customer_id) return account.stripe_customer_id;
  const customer = await stripe('POST', 'customers',
    { email: user.email || '', 'metadata[app]': 'shikaku', 'metadata[user_id]': user.id }, `shikaku-customer-${user.id}`);
  await rpc('shikaku_save_customer', { p_user: user.id, p_customer: customer.id });
  return customer.id;
}

async function checkout(user, account, deps) {
  if (account.open_subscription_id) return [409, { error: 'You already have a plan.' }];
  const customer = await customerFor(user, account, deps);
  const open = await deps.stripe('GET', 'checkout/sessions', { customer, status: 'open', limit: '10' });
  const existing = open.data.find((session) => session.metadata?.app === 'shikaku' && session.url);
  if (existing) return [200, { url: existing.url }];
  const window = Math.floor(deps.now().getTime() / KEY_WINDOW_MS);
  const session = await deps.stripe('POST', 'checkout/sessions', {
    mode: 'subscription', customer,
    'line_items[0][price]': deps.config.priceId, 'line_items[0][quantity]': '1',
    'metadata[app]': 'shikaku',
    'subscription_data[metadata][app]': 'shikaku', 'subscription_data[metadata][user_id]': user.id,
    success_url: `${deps.config.siteUrl}/?subscribed=1`, cancel_url: `${deps.config.siteUrl}/`,
  }, `shikaku-checkout-${user.id}-${window}`);
  return [200, { url: session.url }];
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
    'access-control-allow-origin': deps.config.siteUrl, vary: 'origin',
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
