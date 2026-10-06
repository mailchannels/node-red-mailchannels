'use strict';

class PublicError extends Error {}

const ENDPOINT = 'https://api.mailchannels.net/tx/v1/send';

module.exports = function (RED) {
  function MailChannelsAccount(config) {
    RED.nodes.createNode(this, config);
  }
  RED.nodes.registerType('mailchannels-account', MailChannelsAccount, {
    credentials: { apiKey: { type: 'password' } }
  });

  function MailChannelsSend(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    const account = RED.nodes.getNode(config.account);
    const pending = new Set();
    let closed = false;
    node.on('close', function () {
      closed = true;
      for (const controller of pending) controller.abort();
    });
    node.on('input', async function (msg, send, done) {
      let controller;
      let timer;
      try {
        const apiKey = account?.credentials?.apiKey;
        if (!apiKey) throw new PublicError('Configure the MailChannels account API key.');
        const input = msg.payload;
        if (!input || typeof input !== 'object' || Array.isArray(input)) {
          throw new PublicError('msg.payload must be an email object.');
        }
        const from = input.from || config.from;
        const recipients = input.to || config.to;
        const to = Array.isArray(recipients) ? recipients : typeof recipients === 'string' ? recipients.split(',').map(x => x.trim()) : [];
        const validAddress = value => typeof value === 'string' && /^[^\s@,<>]+@[^\s@,<>]+\.[^\s@,<>]+$/.test(value);
        if (!validAddress(from) || !to.length || !to.every(validAddress)) {
          throw new PublicError('Provide a sender address and one or more valid recipient addresses.');
        }
        const subject = input.subject;
        if (typeof subject !== 'string' || !subject.trim() || /[\r\n]/.test(subject)) {
          throw new PublicError('Provide a nonempty subject without line breaks.');
        }
        const content = [];
        for (const [field, type] of [['text', 'text/plain'], ['html', 'text/html']]) {
          if (input[field] !== undefined && typeof input[field] !== 'string') throw new PublicError('Email content must be text.');
          if (input[field]) content.push({ type, value: input[field] });
        }
        if (!content.length) throw new PublicError('Provide text or html email content.');
        // Dry-run is deployment configuration, never controlled by an incoming message.
        const dryRun = config.dryRun !== false;
        const body = JSON.stringify({ from: { email: from }, personalizations: [{ to: to.map(email => ({ email })) }], subject, content });
        if (closed) throw new PublicError('MailChannels node is stopping.');
        controller = new AbortController();
        pending.add(controller);
        timer = setTimeout(() => controller.abort(), 30000);
        node.status({ fill: 'blue', shape: 'dot', text: dryRun ? 'validating' : 'sending' });
        let response;
        try {
          response = await fetch(ENDPOINT + (dryRun ? '?dry-run=true' : ''), {
            method: 'POST', redirect: 'error', signal: controller.signal,
            headers: { 'Content-Type': 'application/json', 'X-Api-Key': apiKey }, body
          });
        } catch {
          throw new PublicError('MailChannels request failed or timed out; delivery outcome may be unknown. No automatic retry was attempted.');
        }
        // Never log or forward response bodies, which may contain message data.
        if (response.body) await response.body.cancel();
        const expected = dryRun ? 200 : 202;
        if (response.status !== expected) throw new PublicError(`MailChannels returned HTTP ${response.status}; expected ${expected}. No automatic retry was attempted.`);
        msg.mailchannels = { status: dryRun ? 'validated' : 'accepted', statusCode: response.status, dryRun };
        if (!closed) {
          node.status({ fill: 'green', shape: 'dot', text: msg.mailchannels.status });
          send(msg);
        }
        done();
      } catch (err) {
        if (!closed) node.status({ fill: 'red', shape: 'ring', text: 'failed' });
        // Errors constructed above do not include payloads, credentials, or upstream response bodies.
        done(err instanceof PublicError ? err : new Error('MailChannels processing failed; delivery outcome may be unknown. No automatic retry was attempted.'));
      } finally {
        clearTimeout(timer);
        if (controller) pending.delete(controller);
      }
    });
  }
  RED.nodes.registerType('mailchannels-send', MailChannelsSend);
};
