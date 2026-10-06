# MailChannels for Node-RED

Send transactional email through the [MailChannels Email API](https://docs.mailchannels.com/email-api/overview). This package provides a `mailchannels-send` node and a reusable `mailchannels-account` credential configuration.

## Development status

This is an unreleased candidate with [public source and issue tracking](https://github.com/mailchannels/node-red-mailchannels). It is not yet published to npm or listed in the Node-RED Flow Library. Runtime behavior is tested with Node-RED 4.1.8 and 5.0.7 with mocked HTTP responses and real loopback TLS fixtures. The example flow, send configuration dialog, dry-run default, and password credential field were verified in the Node-RED 5.0.7 editor. Live account validation remains outstanding.

Requires Node.js 22 or later and Node-RED 4 or later. For local testing, run `npm install /absolute/path/to/this/package` from your Node-RED user directory, then restart Node-RED. Import the example from the editor's Examples menu.

## Configure

1. Create a MailChannels account and API key with the `api` scope. Follow the [setup guide](https://docs.mailchannels.com/email-api/javascript/quickstart) for Domain Lockdown and domain authentication.
2. Add a MailChannels email node. Create its account configuration and enter the key in the password field. Node-RED stores credentials separately from exported flows; configure its credential encryption and protect access to your editor.
3. Set default sender and recipient addresses, or supply them in `msg.payload`.
4. Keep **Dry run** checked for validation. Uncheck it explicitly in the editor to send real email.

The free plan allows 100 emails per day and restricts recipients to verified account users until a payment method is added. Use a permitted recipient during validation.

## Message format

```json
{
  "payload": {
    "from": "sender@example.com",
    "to": ["recipient@example.com"],
    "subject": "Order received",
    "text": "Thank you for your order.",
    "html": "<p>Thank you for your order.</p>"
  }
}
```

`subject` and at least one of `text` or `html` are required. `to` can be a single address, comma-separated addresses, or an array of addresses. Display-name address syntax is not supported. Payload `from` and `to` override node defaults. Only these documented fields are sent to the API. Incoming messages cannot disable dry-run mode or change the endpoint or credentials.

On success the original message is forwarded with `msg.mailchannels`:

```json
{ "status": "validated", "statusCode": 200, "dryRun": true }
```

A real send returns `accepted`, HTTP 202, and `dryRun: false`. Acceptance does not prove delivery; use [MailChannels webhooks](https://docs.mailchannels.com/email-api/overview) for delivery tracking.

Attach a Catch node for failures. Requests time out after 30 seconds and are cancelled on node shutdown. No automatic retries occur. A network failure can leave the delivery outcome unknown, so an unconditional retry can duplicate email. API response bodies and credentials are not logged or returned. Input/output messages still contain your original email content; avoid logging entire messages with private data.

## Development

Run `npm ci` and `npm test`. Tests load the actual Node-RED runtime and cover flow wiring, password credentials, validation, dry-run/send status handling, input errors, cancellation, and sanitized failures. Ten tests mock HTTP. Nine additional tests use the real fetch implementation and Node-RED runtime against a loopback TLS server, retaining API-hostname verification. They cover200/202, untrusted CA/wrong hostname, redirects, API errors, post-receipt disconnect, the actual30-second timeout, and node-unload cancellation. They use synthetic credentials and no real email. The full19-test suite takes about31seconds and requires OpenSSL for temporary fixture certificates. Test-only routing and CA trust use a development Undici dispatcher; production code is unchanged.

Publication requires a public scoped npm package and a separate [Flow Library submission](https://flows.nodered.org/add/node). A local package or repository does not establish a live listing.

The development dependency audit currently reports 17 advisories in Node-RED tooling. This package ships no runtime dependencies. The suggested automatic fix downgrades Node-RED; no forced downgrade or unverified dependency override has been applied. Keep the development editor local and review upstream dependency updates before operating a shared test environment.
