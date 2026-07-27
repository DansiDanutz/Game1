const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'service-worker.js'), 'utf8');

function loadWorker(overrides = {}) {
  const listeners = {};
  const context = {
    URL,
    Promise,
    self: {
      location: { origin: 'https://game.example' },
      clients: { claim: async () => {} },
      skipWaiting: async () => {},
      addEventListener: (name, listener) => { listeners[name] = listener; },
    },
    caches: {
      open: async () => ({ addAll: async () => {}, put: async () => {} }),
      keys: async () => [],
      delete: async () => true,
      match: async () => undefined,
    },
    fetch: async () => { throw new Error('offline'); },
    ...overrides,
  };
  vm.runInNewContext(source, context, { filename: 'service-worker.js' });
  return { context, listeners };
}

test('failed shell caching rejects installation and preserves the old worker', async () => {
  let skipWaitingCalled = false;
  const { context, listeners } = loadWorker();
  context.caches.open = async () => ({
    addAll: async () => { throw new Error('cache unavailable'); },
  });
  context.self.skipWaiting = async () => { skipWaitingCalled = true; };

  let installation;
  listeners.install({ waitUntil: promise => { installation = promise; } });

  await assert.rejects(installation, /cache unavailable/);
  assert.equal(skipWaitingCalled, false);
});

test('successful network responses keep the fetch event alive through cache storage', async () => {
  const request = { method: 'GET', url: 'https://game.example/js/app.js', mode: 'cors' };
  let originalConsumed = false;
  const response = {
    status: 200,
    clone: () => {
      if (originalConsumed) throw new Error('response body already consumed');
      return { cached: true };
    },
  };
  let cachedRequest;
  let cachedResponse;
  let releaseCache;
  const { context, listeners } = loadWorker({ fetch: async () => response });
  context.caches.open = () => new Promise(resolve => {
    releaseCache = () => resolve({
      put: async (req, res) => { cachedRequest = req; cachedResponse = res; },
    });
  });

  let lifetime;
  let delivery;
  listeners.fetch({
    request,
    waitUntil: promise => { lifetime = promise; },
    respondWith: promise => { delivery = promise; },
  });

  assert.equal(await delivery, response);
  originalConsumed = true;
  releaseCache();
  await lifetime;
  assert.equal(cachedRequest, request);
  assert.deepEqual(cachedResponse, { cached: true });
});

test('offline navigation falls back to the cached application shell', async () => {
  const request = { method: 'GET', url: 'https://game.example/play', mode: 'navigate' };
  const shell = { cached: 'index' };
  const { context, listeners } = loadWorker();
  context.caches.match = async key => key === './index.html' ? shell : undefined;

  let delivery;
  listeners.fetch({
    request,
    waitUntil: () => {},
    respondWith: promise => { delivery = promise; },
  });

  assert.equal(await delivery, shell);
});
