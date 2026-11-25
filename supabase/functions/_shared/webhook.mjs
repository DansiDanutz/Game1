/**
 * Stripe events. Each one only says what to look at: the current state is read
 * back from Stripe, so late, repeated and out-of-order events are harmless.
 */
import { isSigned } from './stripe.mjs';

const MONTH_REASONS = new Set(['subscription_create', 'subscription_cycle']);
const idOf = (value) => (typeof value === 'string' ? value : value?.id) || null;

const MAX_READS = 3;

/**
 * Two events handled at once can each hold an older answer, so what was stored
 * is read again until it stays the same.
 */
async function storeUntilSteady(readOnce, store) {
  let previous;
  for (let i = 0; i < MAX_READS; i++) {
    const value = await readOnce();
    const text = JSON.stringify(value);
    if (!value || text === previous) return;
    await store(value);
    previous = text;
  }
}

/** The plan and its owner when it is this game's, whatever its price. */
async function readPlan(id, { stripe, rpc }) {
  const plan = await stripe('GET', `subscriptions/${id}`);
  if (plan.metadata?.app !== 'shikaku') return null;
  const user = await rpc('shikaku_customer_user', { p_customer: idOf(plan.customer) });
  if (!user || user !== plan.metadata.user_id) return null;
  return { plan, user, item: plan.items?.data?.[0] };
}

function savePlan(object, deps) {
  let seen;
  const readOnce = async () => {
    seen = deps.now().toISOString();
    const found = await readPlan(object.id, deps);
    return found && {
      p_subscription: found.plan.id, p_user: found.user, p_status: found.plan.status,
      p_cancel: Boolean(found.plan.cancel_at_period_end),
      p_period_end: found.item?.current_period_end ? new Date(found.item.current_period_end * 1000).toISOString() : null,
    };
  };
  return storeUntilSteady(readOnce, (plan) => deps.rpc('shikaku_save_subscription', { ...plan, p_seen: seen }));
}

const planIdOf = (invoice) => idOf(invoice.parent?.subscription_details?.subscription);
const buysMonth = (invoice) => Boolean(planIdOf(invoice)) && MONTH_REASONS.has(invoice.billing_reason) && invoice.amount_paid > 0;

/** Events use the endpoint's API version, so the invoice is read back in ours. */
async function grantMonth(event, deps) {
  const invoice = await deps.stripe('GET', `invoices/${event.id}`);
  if (!buysMonth(invoice)) return;
  const found = await readPlan(planIdOf(invoice), deps);
  if (!found) return;
  const credits = Number(found.item?.price?.metadata?.play_credits);
  if (!Number.isInteger(credits) || credits < 1) throw new Error(`The price of ${invoice.id} has no play_credits`);
  await deps.rpc('shikaku_grant_credits', { p_invoice: invoice.id, p_user: found.user, p_credits: credits });
}

/** The paid month behind a charge when it is this game's, or null. */
async function monthOf(charge, deps) {
  const customer = idOf(charge.customer);
  const intent = idOf(charge.payment_intent);
  if (!customer || !intent || !(await deps.rpc('shikaku_customer_user', { p_customer: customer }))) return null;
  const paid = await deps.stripe('GET', 'invoice_payments', { 'payment[type]': 'payment_intent', 'payment[payment_intent]': intent });
  const invoiceId = idOf(paid.data[0]?.invoice);
  if (!invoiceId) return null;
  const invoice = await deps.stripe('GET', `invoices/${invoiceId}`);
  return buysMonth(invoice) && (await readPlan(planIdOf(invoice), deps)) ? invoiceId : null;
}

function takeBack(source, readCharge, deps) {
  let seen;
  const readOnce = async () => {
    seen = deps.now().toISOString();
    const { charge, cents } = await readCharge();
    const invoiceId = await monthOf(charge, deps);
    return invoiceId && { p_invoice: invoiceId, p_source: source, p_cents: cents, p_total: charge.amount };
  };
  return storeUntilSteady(readOnce, async (share) => {
    const isKnown = await deps.rpc('shikaku_set_clawback', { ...share, p_seen: seen });
    if (!isKnown) throw new Error(`${source} for ${share.p_invoice} arrived before its credits`);
  });
}

function refundCharge(chargeId, deps) {
  if (!chargeId) return undefined;
  return takeBack('refund', async () => {
    const charge = await deps.stripe('GET', `charges/${chargeId}`);
    return { charge, cents: charge.amount_refunded };
  }, deps);
}

function disputeCharge(object, deps) {
  return takeBack('dispute', async () => {
    const dispute = await deps.stripe('GET', `disputes/${object.id}`);
    const charge = await deps.stripe('GET', `charges/${idOf(dispute.charge)}`);
    const withdrawn = -(dispute.balance_transactions ?? []).reduce((sum, t) => sum + t.amount, 0);
    return { charge, cents: withdrawn > 0 ? dispute.amount : 0 };
  }, deps);
}

const HANDLERS = new Map([
  ['customer.subscription.created', savePlan],
  ['customer.subscription.updated', savePlan],
  ['customer.subscription.deleted', savePlan],
  ['invoice.paid', grantMonth],
  ['charge.refunded', (charge, deps) => refundCharge(charge.id, deps)],
  ['refund.failed', (refund, deps) => refundCharge(idOf(refund.charge), deps)],
  ['charge.dispute.funds_withdrawn', disputeCharge],
  ['charge.dispute.funds_reinstated', disputeCharge],
]);

const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export async function handleWebhook(req, deps) {
  if (req.method !== 'POST') return reply(405, { error: 'Use POST.' });
  const body = await req.text();
  if (!(await isSigned(body, req.headers.get('stripe-signature'), deps.config.webhookSecret, deps.now()))) {
    return reply(400, { error: 'Invalid signature.' });
  }
  const event = JSON.parse(body);
  if (event.livemode !== deps.config.isLive) return reply(200, { received: true });
  try {
    await HANDLERS.get(event.type)?.(event.data.object, deps);
  } catch (error) {
    deps.log('webhook failed', event.id, event.type, error);
    return reply(500, { error: 'Try again.' });
  }
  return reply(200, { received: true });
}
