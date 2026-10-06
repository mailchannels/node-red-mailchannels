'use strict';
const assert = require('node:assert/strict');
const helper = require('node-red-node-test-helper');
const nodes = require('../nodes/mailchannels');
helper.init(require.resolve('node-red'));

describe('MailChannels runtime', function () {
  let originalFetch;
  let calls;
  const key = 'test-secret-never-return';
  beforeEach(function (done) {
    originalFetch = global.fetch;
    calls = [];
    global.fetch = async (url, options) => { calls.push({ url, options }); return new Response(null, { status: 200 }); };
    helper.startServer(done);
  });
  afterEach(async function () {
    await helper.unload();
    await new Promise(resolve => helper.stopServer(resolve));
    global.fetch = originalFetch;
  });
  async function load(config = {}, credentials = { account: { apiKey: key } }) {
    await helper.load(nodes, [
      { id: 'account', type: 'mailchannels-account' },
      { id: 'send', type: 'mailchannels-send', account: 'account', from: 'sender@example.com', to: 'recipient@example.com', wires: [['out']], ...config },
      { id: 'out', type: 'helper' }
    ], credentials);
    return helper.getNode('send');
  }
  const payload = () => ({ subject: 'Test', text: 'Plain text', html: '<p>HTML</p>' });
  function invoke(node, data) {
    return new Promise(resolve => {
      const result = { output: undefined, error: undefined };
      node._inputCallback(data, output => { result.output = output; }, error => { result.error = error; resolve(result); });
    });
  }
  it('loads account credentials and validates by default, preserving the message', async function () {
    const node = await load();
    const result = await invoke(node, { payload: payload(), correlation: 'keep' });
    assert.equal(result.error, undefined);
    assert.deepEqual(result.output.mailchannels, { status: 'validated', statusCode: 200, dryRun: true });
    assert.equal(result.output.correlation, 'keep');
    assert.equal(calls[0].url, 'https://api.mailchannels.net/tx/v1/send?dry-run=true');
    assert.equal(calls[0].options.headers['X-Api-Key'], key);
    assert.equal(calls[0].options.redirect, 'error');
    assert.equal(JSON.parse(calls[0].options.body).content.length, 2);
    assert(!JSON.stringify(result.output).includes(key));
  });
  it('sends through actual Node-RED flow wiring', async function () {
    const node = await load();
    const received = new Promise(resolve => helper.getNode('out').once('input', resolve));
    node.receive({ payload: payload() });
    assert.equal((await received).mailchannels.status, 'validated');
  });
  it('accepts send mode only from deployment configuration', async function () {
    const node = await load({ dryRun: false });
    global.fetch = async (url, options) => { calls.push({ url, options }); return new Response(null, { status: 202 }); };
    const result = await invoke(node, { payload: { ...payload(), to: ['a@example.com', 'b@example.com'] } });
    assert.equal(result.output.mailchannels.status, 'accepted');
    assert.equal(calls[0].url, 'https://api.mailchannels.net/tx/v1/send');
    assert.equal(JSON.parse(calls[0].options.body).personalizations[0].to.length, 2);
  });
  it('incoming dryRun false cannot switch off validation', async function () {
    const node = await load({ dryRun: true });
    const result = await invoke(node, { dryRun: false, payload: { ...payload(), dryRun: false } });
    assert.equal(result.output.mailchannels.dryRun, true);
  });
  it('rejects missing credentials before network access', async function () {
    const node = await load({}, {});
    assert.match((await invoke(node, { payload: payload() })).error.message, /API key/);
    assert.equal(calls.length, 0);
  });
  it('rejects malformed content, recipient, and subject before network access', async function () {
    const node = await load();
    for (const input of [null, {}, { ...payload(), to: [] }, { ...payload(), to: 'bad' }, { ...payload(), subject: 'bad\r\nheader' }, { ...payload(), text: {} }]) {
      assert((await invoke(node, { payload: input })).error);
    }
    assert.equal(calls.length, 0);
  });
  it('does not expose response bodies or retry an API rejection', async function () {
    const node = await load();
    global.fetch = async () => { calls.push(1); return new Response('private message ' + key, { status: 401 }); };
    const result = await invoke(node, { payload: payload() });
    assert.match(result.error.message, /HTTP 401/);
    assert(!result.error.message.includes(key));
    assert.equal(result.output, undefined);
    assert.equal(calls.length, 1);
  });
  it('does not treat send acceptance as successful dry-run validation', async function () {
    const node = await load();
    global.fetch = async () => new Response(null, { status: 202 });
    assert((await invoke(node, { payload: payload() })).error);
  });
  it('sanitizes network exceptions and does not retry', async function () {
    const node = await load();
    global.fetch = async () => { calls.push(1); throw new Error(key); };
    const result = await invoke(node, { payload: payload() });
    assert(!result.error.message.includes(key));
    assert.match(result.error.message, /outcome may be unknown/);
    assert.equal(calls.length, 1);
  });
  it('aborts an outstanding request when redeployed', async function () {
    const node = await load();
    let signal;
    global.fetch = (url, options) => new Promise((resolve, reject) => {
      signal = options.signal;
      signal.addEventListener('abort', () => reject(new Error(key)));
    });
    const pending = invoke(node, { payload: payload() });
    await helper.unload();
    assert.equal(signal.aborted, true);
    assert((await pending).error);
  });
});
