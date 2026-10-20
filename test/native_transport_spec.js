'use strict';
const assert = require('node:assert/strict');
const https = require('node:https');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { Agent, buildConnector, getGlobalDispatcher, setGlobalDispatcher } = require('undici');
const helper = require('node-red-node-test-helper');
const nodes = require('../nodes/mailchannels');
helper.init(require.resolve('node-red'));

describe('MailChannels native TLS transport', function () {
  this.timeout(45000);
  let directory, valid, wrong, server, agent, originalDispatcher, requests, mode, status, received;
  const credentials = { account: { apiKey: 'synthetic-native-key' } };
  function certificate(host, name) {
    const key = path.join(directory, name + '.key');
    const cert = path.join(directory, name + '.pem');
    execFileSync('openssl', ['req','-x509','-newkey','rsa:2048','-nodes','-days','1',
      '-keyout',key,'-out',cert,'-subj','/CN=' + host,'-addext','subjectAltName=DNS:' + host], { stdio: 'ignore' });
    return { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
  }
  before(function () {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-node-red-tls-'));
    valid = certificate('api.mailchannels.net', 'valid');
    wrong = certificate('wrong.example.test', 'wrong');
  });
  after(function () { fs.rmSync(directory, { recursive: true, force: true }); });
  beforeEach(async function () {
    requests = []; mode = 'response'; status = 200;
    originalDispatcher = getGlobalDispatcher();
    server = https.createServer(valid, async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      requests.push({ path: req.url, headers: req.headers, body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined });
      if (received) received();
      if (mode === 'disconnect') { req.socket.destroy(); return; }
      if (mode === 'timeout') return; // The client's actual30-second timer aborts this request.
      res.writeHead(status, { 'Content-Length': '0', ...(status >= 300 && status < 400 ? { Location: 'https://api.mailchannels.net/collect' } : {}) });
      res.end();
    });
    server.on('tlsClientError', () => {});
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    await new Promise(resolve => helper.startServer(resolve));
  });
  afterEach(async function () {
    await helper.unload();
    await new Promise(resolve => helper.stopServer(resolve));
    setGlobalDispatcher(originalDispatcher);
    if (agent) await agent.destroy();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    received = undefined; agent = undefined;
  });
  async function load(config = {}, ca = valid.cert) {
    await helper.load(nodes, [
      { id: 'account', type: 'mailchannels-account' },
      { id: 'send', type: 'mailchannels-send', account: 'account', from: 'sender@example.test', to: 'team@example.test', wires: [['out']], ...config },
      { id: 'out', type: 'helper' }
    ], credentials);
    const connector = buildConnector({ ca, rejectUnauthorized: true });
    agent = new Agent({ connect(options, callback) {
      assert.equal(options.hostname, 'api.mailchannels.net');
      assert.equal(options.protocol, 'https:');
      assert.equal(String(options.port || 443), '443');
      return connector({ ...options, hostname: '127.0.0.1', port: server.address().port, servername: 'api.mailchannels.net' }, callback);
    } });
    setGlobalDispatcher(agent);
    return helper.getNode('send');
  }
  function invoke(node) {
    return new Promise(resolve => {
      let output;
      node._inputCallback({ payload: { subject: 'Synthetic fixture', text: 'No live email' } },
        msg => { output = msg; }, error => resolve({ output, error }));
    });
  }
  function failed(result) {
    assert(result.error);
    assert.equal(result.output, undefined);
    assert(!result.error.message.includes('synthetic-native-key'));
  }
  it('uses verified TLS and real fetch for default dry-run', async function () {
    const result = await invoke(await load());
    assert.equal(result.error, undefined);
    assert.deepEqual(result.output.mailchannels, { status: 'validated', statusCode: 200, dryRun: true });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].path, '/tx/v1/send?dry-run=true');
    assert.equal(requests[0].headers['x-api-key'], 'synthetic-native-key');
    assert.equal(requests[0].body.personalizations[0].to[0].email, 'team@example.test');
  });
  it('handles native empty202 as acceptance, not delivery', async function () {
    status = 202;
    const result = await invoke(await load({ dryRun: false }));
    assert.equal(result.error, undefined);
    assert.deepEqual(result.output.mailchannels, { status: 'accepted', statusCode: 202, dryRun: false });
    assert.equal(requests[0].path, '/tx/v1/send');
  });
  it('rejects an untrusted CA before an HTTP request', async function () {
    failed(await invoke(await load({}, wrong.cert)));
    assert.equal(requests.length, 0);
  });
  it('rejects a trusted certificate with the wrong hostname', async function () {
    server.setSecureContext(wrong);
    failed(await invoke(await load({}, wrong.cert)));
    assert.equal(requests.length, 0);
  });
  it('does not follow redirects', async function () {
    const node = await load();
    for (status of [301,302,303,307,308]) {
      const before = requests.length;
      failed(await invoke(node));
      assert.equal(requests.length, before + 1);
    }
  });
  it('does not retry API rejections or server errors', async function () {
    const node = await load();
    for (status of [400,401,429,500,503]) {
      const before = requests.length;
      const result = await invoke(node); failed(result);
      assert(result.error.message.includes('HTTP ' + status));
      assert.equal(requests.length, before + 1);
    }
  });
  it('does not retry disconnect after receipt', async function () {
    mode = 'disconnect';
    failed(await invoke(await load()));
    assert.equal(requests.length, 1);
  });
  it('aborts on the actual30-second deadline without retry', async function () {
    mode = 'timeout';
    const node = await load(); const started = performance.now();
    failed(await invoke(node));
    assert(performance.now() - started >= 29000);
    assert.equal(requests.length, 1);
  });
  it('aborts an in-flight request on node unload without output', async function () {
    mode = 'timeout';
    const node = await load();
    const receipt = new Promise(resolve => { received = resolve; });
    const pending = invoke(node);
    await receipt; await helper.unload();
    failed(await pending);
    assert.equal(requests.length, 1);
  });
});
