// Deploy without the JWT check: Stripe proves itself with its signature.
import { readConfig } from "../_shared/config.mjs";
import { stripeClient } from "../_shared/stripe.mjs";
import { databaseRpc } from "../_shared/supabase.mjs";
import { handleWebhook } from "../_shared/webhook.mjs";

const config = readConfig(Deno.env.toObject());
const deps = {
  config,
  now: () => new Date(),
  stripe: stripeClient(config.stripeKey),
  rpc: databaseRpc(config),
  log: console.error,
};

Deno.serve((req: Request) => handleWebhook(req, deps));
