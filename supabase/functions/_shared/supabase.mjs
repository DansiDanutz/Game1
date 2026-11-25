/** Database and sign-in calls for the Stripe functions. */
export function databaseRpc(config, fetchFn = fetch) {
  return async (name, args) => {
    const res = await fetchFn(`${config.supabaseUrl}/rest/v1/rpc/${name}`, {
      method: 'POST',
      headers: { apikey: config.serviceKey, authorization: `Bearer ${config.serviceKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(args),
    });
    if (!res.ok) throw new Error(`Database answered ${res.status} to ${name}`);
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  };
}

/** The signed-in user, checked with Supabase Auth, or null. */
export function userLookup(config, fetchFn = fetch) {
  return async (authorization) => {
    if (!/^Bearer \S+$/.test(authorization || '')) return null;
    const res = await fetchFn(`${config.supabaseUrl}/auth/v1/user`, { headers: { apikey: config.anonKey, authorization } });
    if (res.status === 401 || res.status === 403) return null;
    if (!res.ok) throw new Error(`Sign-in check answered ${res.status}`);
    const user = await res.json();
    return user?.id ? { id: user.id, email: user.email } : null;
  };
}
