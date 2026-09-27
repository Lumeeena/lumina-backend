# Authenticating with the Lumina API

The Lumina GraphQL API is moving from fully open access to API keys with
per-key rate limits. This page covers everything a client needs: how to get a
key, how to send it, how to read the rate limit headers, what happens when
you are throttled, what anonymous access still gets, and when each change
takes effect.

**Nothing is enforced yet.** Everything described here rolls out in the
phases listed under [Migration timeline](#migration-timeline). If you follow
this page now, your client will keep working through every phase.

## Quick start

1. [Get a key](#obtaining-a-key). It looks like `lum_` followed by 64 hex characters.
2. Send it on every request:

   ```bash
   curl https://lumina-api.stellar.org/graphql \
     -H 'Content-Type: application/json' \
     -H 'Authorization: Bearer lum_0123456789abcdef...' \
     -d '{"query":"{ latestLedger { sequence closedAt } }"}'
   ```

3. Watch the `X-RateLimit-Remaining` response header, and when you get a
   `RATE_LIMITED` error, wait `Retry-After` seconds before retrying.

## Obtaining a key

### Hosted API (`lumina-api.stellar.org`)

Open an issue at <https://github.com/Lumeeena/lumina-backend/issues> titled
**"API key request"** that includes:

- a name for your application (this becomes the key's label)
- a contact the maintainers can use to send you the key privately
- the request rate you expect at peak, in requests per minute

A maintainer creates the key and sends it to you **privately**. Never paste a
key into an issue, pull request, or any other public place. If one leaks,
open a new request and ask for the old key to be revoked.

New keys get **60 requests per minute** unless you asked for something else
and the maintainers agreed to it.

### Self-hosted Lumina

Operators create keys with the key management CLI (full reference:
[`API_KEY_MANAGEMENT.md`](API_KEY_MANAGEMENT.md)):

```bash
npm run manage-keys -- create my-app 120   # label, requests per minute
```

The plaintext key is printed **once**. Only a SHA-256 hash is stored, so a
lost key can't be recovered. Revoke it and create a new one.

## Sending the key

### HTTP queries and mutations

Put the key in the `Authorization` header with the `Bearer` scheme:

```
Authorization: Bearer lum_<64 hex characters>
```

That is the only place the server looks. Keys in query strings, cookies, or
the GraphQL request body are ignored, and the request is treated as
anonymous.

**Apollo Client**

```typescript
import { ApolloClient, HttpLink, InMemoryCache } from '@apollo/client';

const client = new ApolloClient({
  link: new HttpLink({
    uri: 'https://lumina-api.stellar.org/graphql',
    headers: { Authorization: `Bearer ${process.env.LUMINA_API_KEY}` },
  }),
  cache: new InMemoryCache(),
});
```

**Plain `fetch`**

```typescript
const res = await fetch('https://lumina-api.stellar.org/graphql', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${process.env.LUMINA_API_KEY}`,
  },
  body: JSON.stringify({ query: '{ latestLedger { sequence } }' }),
});
```

### WebSocket subscriptions

Browsers can't set headers on a WebSocket handshake, so subscriptions send
the key in the `graphql-ws` `connection_init` payload, under the same
`Authorization` name and in the same format:

```typescript
import { createClient } from 'graphql-ws';

const client = createClient({
  url: 'wss://lumina-api.stellar.org/graphql',
  connectionParams: {
    Authorization: `Bearer ${process.env.LUMINA_API_KEY}`,
  },
});
```

The key is checked once, when the connection opens. If it is revoked while
the socket is open, the server closes the connection, and reconnecting with
that key fails.

### Keeping the key secret

- Use keys from server-side code only. A key shipped in a browser bundle or
  a mobile app binary is public, and anyone can use up your quota with it.
- A browser-only app should either call the API anonymously (see
  [Anonymous access](#anonymous-access)) or go through a small backend of its
  own that adds the key.
- Load the key from an environment variable or a secret store, not from
  source control.
- **To rotate a key:** request or create a new one, deploy it, and then revoke
  the old one. Revocation takes effect on the very next request, with no
  grace period.

## Rate limits

Each key has its own limit, counted in requests per minute. Every request
counts, whatever it asks for.

The limit is a **token bucket**. It holds up to your per-minute limit in
tokens and refills at an even rate (a 60/min key gets one token back per
second). Each request spends one token. You can burst up to the full limit
after a quiet period, but your sustained rate can't go above the limit.

Limits apply per key, not per server. If several of your processes share one
key, they share one bucket.

Opening a subscription costs one request. Events delivered over a
subscription that is already open are free.

> Rate limits may later be weighted by query cost, so that a deeply nested
> query costs more than `latestLedger`. That would change how quickly your
> quota runs down, so it will be announced in the
> [changelog](../CHANGELOG.md) with at least the same notice as a
> [migration phase](#migration-timeline), along with the cost model.

### Rate limit headers

Every HTTP response, including errors, carries these headers:

| Header | Meaning |
| --- | --- |
| `X-RateLimit-Limit` | Your bucket's size, which is the same as your per-minute limit |
| `X-RateLimit-Remaining` | Requests you can make right now without being throttled |
| `X-RateLimit-Reset` | Unix time, in seconds, at which your bucket will be full again |

A throttled response also carries:

| Header | Meaning |
| --- | --- |
| `Retry-After` | Seconds to wait before the next request can succeed |

Example of a response from a healthy client:

```
HTTP/1.1 200 OK
X-RateLimit-Limit: 60
X-RateLimit-Remaining: 57
X-RateLimit-Reset: 1790000123
```

### When you are throttled

A throttled request gets HTTP `429` and a normal GraphQL error body, so your
existing GraphQL error handling still sees it:

```json
{
  "errors": [
    {
      "message": "Rate limit exceeded: 60 requests per minute. Retry after 2 seconds.",
      "extensions": {
        "code": "RATE_LIMITED",
        "limit": 60,
        "retryAfter": 2
      }
    }
  ]
}
```

`extensions.retryAfter` has the same value as the `Retry-After` header. It is
there for clients whose GraphQL library hides response headers.

What to do:

1. **Wait `retryAfter` seconds, then retry.** Don't retry right away: the
   retry is throttled too and just burns a round trip.
2. **Add jitter** (a random 0–1 s on top) if many workers share one key, so
   they don't all retry at the same moment.
3. **Slow down before you hit the limit.** When `X-RateLimit-Remaining`
   drops near zero, spread out your requests instead of sending them until
   one fails.
4. **If you are always near the limit,** ask for a higher one in a new
   "API key request" issue with your current key's label and the rate you
   need.

A minimal retry wrapper:

```typescript
async function lumina(body: object, attempt = 0): Promise<any> {
  const res = await fetch('https://lumina-api.stellar.org/graphql', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.LUMINA_API_KEY}`,
    },
    body: JSON.stringify(body),
  });

  if (res.status === 429 && attempt < 5) {
    const retryAfter = Number(res.headers.get('Retry-After') ?? '1');
    await new Promise(r => setTimeout(r, (retryAfter + Math.random()) * 1000));
    return lumina(body, attempt + 1);
  }
  return res.json();
}
```

## Anonymous access

Requests without an `Authorization` header are still served, under a
smaller shared tier:

| | Anonymous | With a key |
| --- | --- | --- |
| Limit | **20 requests per minute** | 60 requests per minute (default), adjustable per key |
| Counted per | Client IP address | Key |
| Subscriptions | Allowed. Opening one costs one request | Allowed. Opening one costs one request |
| Rate limit headers | Yes | Yes |

Anonymous access is for trying the API, for low-traffic browser apps, and
for clients that haven't migrated yet. It is **not** suited to production
backends, because:

- Everyone behind the same NAT, corporate proxy, or cloud egress IP shares
  one 20/min bucket, so a neighbour can use up your quota.
- The anonymous limit may be lowered if abuse requires it. Keyed limits are
  not changed without talking to the key's owner.

Self-hosted operators can change the anonymous limit or turn anonymous
access off entirely. Check with whoever runs your instance.

## Authentication errors

A missing key is never an error: the request is simply anonymous. A key that
is present but can't be used is always rejected. The server doesn't
quietly fall back to anonymous access, because that would hide a broken
deployment until the tighter anonymous limit started to bite.

Rejected keys get HTTP `401` and a GraphQL error body:

```json
{
  "errors": [
    {
      "message": "API key is invalid or has been revoked.",
      "extensions": { "code": "UNAUTHENTICATED" }
    }
  ]
}
```

| Cause | What to do |
| --- | --- |
| Header is not in the form `Bearer lum_...` | Check the header name, the `Bearer ` prefix, and that there are no extra quotes or whitespace |
| The key doesn't exist | Check that you copied all of it (68 characters including `lum_`) |
| The key has been revoked | Request a new key. Revoked keys never come back |

For security, the message doesn't say which of these it was.

Handle errors by checking `extensions.code`, not the HTTP status or the
message text. These codes join the ones listed in
[`API_GUIDE.md`](API_GUIDE.md#common-error-codes):

| Code | HTTP status | Meaning |
| --- | --- | --- |
| `UNAUTHENTICATED` | 401 | An API key was sent but is malformed, unknown, or revoked |
| `RATE_LIMITED` | 429 | Your key's (or your IP's anonymous) bucket is empty. See `extensions.retryAfter` |

## Migration timeline

Auth is switched on in phases so that no existing client breaks without
warning. **Each phase starts only after it has been announced in the
[changelog](../CHANGELOG.md), at least four weeks ahead**, with the date it
takes effect. The dates are filled in below as each phase is announced.

| Phase | Starts | What changes | What you need to do |
| --- | --- | --- | --- |
| **0: Documented** | This page is published | Nothing is enforced. | Request a key. |
| **1: Keys accepted** | Announced in the changelog | Keys are validated and invalid ones get `UNAUTHENTICATED`. Every response carries `X-RateLimit-*` headers. **Limits are reported but not enforced**, so no request gets a 429. | Start sending your key. Check that your requests succeed and that `X-RateLimit-Remaining` doesn't hit zero under your normal traffic. |
| **2: Keyed limits enforced** | At least 4 weeks after phase 1 | Requests with a key are throttled at the key's limit. Anonymous requests are still unlimited. | Handle `RATE_LIMITED` as described [above](#when-you-are-throttled). |
| **3: Anonymous tier enforced** | At least 4 weeks after phase 2 | Anonymous requests are limited to 20 per minute per IP. | Any client that still runs without a key must now fit in the anonymous tier, or get a key. |

Some guarantees for the rollout:

- A phase never starts earlier than its announced date. If it slips, the
  changelog is updated.
- During phase 1 you can make sure your integration is right before
  anything can fail: a wrong key gets an error, but no limit is enforced.
- Anonymous access is not scheduled for removal. If that ever changes, it
  gets its own announced phase with the same notice.

### Checklist for existing clients

- [ ] Request a key (or create one, if you run your own instance).
- [ ] Store it as a server-side secret, never in client-side code.
- [ ] Send `Authorization: Bearer <key>` on HTTP requests and in the
      `connectionParams` of subscriptions.
- [ ] Treat `UNAUTHENTICATED` as a configuration error. Alert on it and
      don't retry.
- [ ] Treat `RATE_LIMITED` as transient: wait `retryAfter` seconds plus
      jitter, then retry.
- [ ] Log `X-RateLimit-Remaining` so you can see how close to the limit you
      run before phase 2 starts enforcing it.
