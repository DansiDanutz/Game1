/** Settings for the Stripe functions. Throws with names only, never values. */
const REQUIRED = ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'SHIKAKU_PRICE_ID', 'SHIKAKU_SITE_URL',
  'SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY'];

export function readConfig(env) {
  const missing = REQUIRED.filter((name) => !env[name]);
  if (missing.length) throw new Error(`Missing settings: ${missing.join(', ')}`);
  const isTestKey = /^(sk|rk)_test_/.test(env.STRIPE_SECRET_KEY);
  if (!isTestKey && env.SHIKAKU_LIVE_PAYMENTS !== 'approved') {
    throw new Error('Live payments are off until Stripe has approved the game');
  }
  // Anyone can pay with a test card, so test keys must never add real credits.
  if (isTestKey && env.SHIKAKU_TEST_PAYMENTS !== 'staging') {
    throw new Error('Test payments are only for a staging database');
  }
  return {
    stripeKey: env.STRIPE_SECRET_KEY, webhookSecret: env.STRIPE_WEBHOOK_SECRET, priceId: env.SHIKAKU_PRICE_ID,
    siteUrl: env.SHIKAKU_SITE_URL.replace(/\/+$/, ''), supabaseUrl: env.SUPABASE_URL,
    anonKey: env.SUPABASE_ANON_KEY, serviceKey: env.SUPABASE_SERVICE_ROLE_KEY, isLive: !isTestKey,
  };
}
