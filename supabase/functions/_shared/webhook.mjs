/**
 * Stripe events. Each one only says what to look at: the current state is read
 * back from Stripe, so late, repeated and out-of-order events are harmless.
 */
import { isSigned } from './stripe.mjs';

const MONTH_REASONS = new Set(['subscription_create', 'subscription_cycle']);
const idOf = (value) => (typeof value === 'string' ? value : value?.id) || null;

/** The plan when it is this game's, with its owner and credits. */
async function readPlan(id, { stripe, rpc, config, now }) {
  const seen = now().toISOString();
  const plan = await stripe('GET', `subscriptions/${id}`);
  const item = plan.items?.data?.[0];
  if (plan.metadata?.app !== 'shikaku' || item?.price?.id !== config.priceId) return null;
  const user = await rpc('shikaku_customer_user', { p_customer: idOf(plan.customer) });
  if (!user || user !== plan.metadata.user_id) return null;
  const credits = Number(item.price.metadata?.play_credits);
  if (!Number.isInteger(credits) || credits < 1) throw new Error('The price has no play_credits');
  return { plan, user, credits, seen, periodEnd: item.current_period_end };
}

async function savePlan(object, deps) {
  const found = await readPlan(object.id, deps);
  if (!found) return;
  await deps.rpc('shikaku_save_subscription', {
    p_subscription: found.plan.id, p_user: found.user, p_status: found.plan.status,
    p_cancel: Boolean(found.plan.cancel_at_period_end), p_seen: found.seen,
    p_period_end: found.periodEnd ? new Date(found.periodEnd * 1000).toISOString() : null,
  });
}

const planIdOf = (invoice) => idOf(invoice.parent?.subscription_details?.subscription);
const buysMonth = (invoice) => Boolean(planIdOf(invoice)) && MONTH_REASONS.has(invoice.billing_reason) && invoice.amount_paid > 0;

async function grantMonth(invoice, deps) {
  if (!buysMonth(invoice)) return;
  const found = await readPlan(planIdOf(invoice), deps);
  if (!found) return;
  await deps.rpc('shikaku_grant_credits', { p_invoice: invoice.id, p_user: found.user, p_credits: found.credits });
}

async function setClawback(source, charge, cents, seen, deps) {
  const customer = idOf(charge.customer);
  const intent = idOf(charge.payment_intent);
  if (!customer || !intent || !(await deps.rpc('shikaku_customer_user', { p_customer: customer }))) return;
  const paid = await deps.stripe('GET', 'invoice_payments', { 'payment[type]': 'payment_intent', 'payment[payment_intent]': intent });
  const invoiceId = idOf(paid.data[0]?.invoice);
  if (!invoiceId) return;
  const invoice = await deps.stripe('GET', `invoices/${invoiceId}`);
  if (!buysMonth(invoice)) return;
  const found = await readPlan(planIdOf(invoice), deps);
  if (!found) return;
  const credits = Math.floor((found.credits * Math.min(cents, charge.amount)) / charge.amount);
  const isKnown = await deps.rpc('shikaku_set_clawback', { p_invoice: invoiceId, p_source: source, p_credits: credits, p_seen: seen });
  if (!isKnown) throw new Error(`${source} for ${invoiceId} arrived before its credits`);
}

async function refundCharge(chargeId, deps) {
  if (!chargeId) return;
  const seen = deps.now().toISOString();
  const charge = await deps.stripe('GET', `charges/${chargeId}`);
  await setClawback('refund', charge, charge.amount_refunded, seen, deps);
}

async function disputeCharge(object, deps) {
  const seen = deps.now().toISOString();
  const dispute = await deps.stripe('GET', `disputes/${object.id}`);
  const charge = await deps.stripe('GET', `charges/${idOf(dispute.charge)}`);
  const withdrawn = -(dispute.balance_transactions ?? []).reduce((sum, t) => sum + t.amount, 0);
  await setClawback('dispute', charge, withdrawn > 0 ? dispute.amount : 0, seen, deps);
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
