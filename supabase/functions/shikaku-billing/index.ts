import { handleBilling } from "../_shared/billing.mjs";
import { readConfig } from "../_shared/config.mjs";
import { stripeClient } from "../_shared/stripe.mjs";
import { databaseRpc, userLookup } from "../_shared/supabase.mjs";

const config = readConfig(Deno.env.toObject());
const deps = {
  config,
  now: () => new Date(),
  stripe: stripeClient(config.stripeKey),
  rpc: databaseRpc(config),
  getUser: userLookup(config),
  log: console.error,
};

Deno.serve((req: Request) => handleBilling(req, deps));
