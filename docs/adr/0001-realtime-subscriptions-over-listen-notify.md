# 0001. Real-time subscriptions use Postgres LISTEN/NOTIFY, not a broker

- **Status:** accepted
- **Date:** 2026-09-27
- **Sources:** `README.md` ("Real-time path"), the file docblocks in
  `indexer/src/notify.ts` and `graphql-server/src/pubsub.ts`, and commit
  `82b3759`.

## Context

The indexer and the GraphQL server are separate processes, and clients hold
subscriptions open over websockets expecting a push when a ledger lands. The
push path has to cross a process boundary. Both processes already hold a
connection to the same PostgreSQL database, and one of them is already writing
the rows the subscriber wants to hear about.

## Options considered

**An in-memory pub/sub** (the shape Apollo Server ships with). It cannot join
two processes: an event published in the indexer's heap is invisible to the
server's. This is the alternative the repository names and rejects — *"the
indexer and the GraphQL server are separate processes, so an in-memory `PubSub`
cannot join them"* (`indexer/src/notify.ts`).

**A dedicated broker.** The recorded argument is cost, not capability:
LISTEN/NOTIFY *"costs no new infrastructure: both processes already hold a
connection to the same database"*. Redis is not named anywhere in the
repository; the alternative as documented is a broker in general, weighed
against infrastructure that would have to be deployed, monitored and paid for
to move a message between two processes that already share a database.

**SSE rather than websockets** for the transport was weighed in the same commit
and is a separate decision: `graphql-ws` was chosen because the frontend's
subscription client already spoke that protocol, and adopting SSE would have
meant rewriting a working client.

## Decision

Notify over `LISTEN`/`NOTIFY`, with three properties that the file docblocks
treat as load-bearing rather than incidental:

- **The notification is queued inside the writing transaction.** Postgres
  delivers notifications at commit, so a rolled-back ledger announces nothing
  and no subscriber is ever told about rows that did not land.
- **The payload carries counts, not content.** It names the ledger and a few
  counts; the server reads the rows back out of the database.
- **The `LISTEN` connection is supervised.** It reconnects with backoff and
  re-issues `LISTEN`, because a listener that dies silently is indistinguishable
  from a quiet network.

`pg_notify()` is called rather than using the `NOTIFY` statement, because
`NOTIFY` takes a literal rather than a bind parameter — the payload would have
to be built by string concatenation, *"an injection waiting to happen"*
(`indexer/src/notify.ts`).

## Consequences

**A payload ceiling is accepted deliberately.** Postgres caps a NOTIFY payload
at 8000 bytes, and a busy ledger's transaction hashes alone exceed it. The
notification therefore says only what changed and where, and the subscriber
pays one extra query per ledger — roughly every five seconds — to read the rows.
A truncated notification would be worse than a small one, because the
subscriber cannot tell that it was truncated. The repository enforces its own
4000-byte ceiling so a future field cannot push a payload over Postgres's limit
by surprise.

**The listener is a failure domain of its own.** It can be killed by an indexer
restart, a failover or an idle-connection reaper. A lost listener is therefore
deliberately *not* fatal to the health check — queries still work without it —
and is surfaced instead as `lumina_graphql_listener_connected`, with a runbook
entry in `README.md`.

**Subscribers are pinned to the primary**, which is why `READ_DATABASE_URL` does
not apply to them: a subscriber replays the exact ledger the primary just
announced, and reading that replay from a lagging replica could return no rows
and silently drop the notification (see ADR 0004's sibling note in
`docs/DATABASE_OPERATIONS.md`).

**The notification shape is a protocol between two independently deployed
processes**, and is deliberately duplicated in `graphql-server/src/notifications.ts`
rather than shared: the reader must tolerate a writer at a different version,
which is what the parser is written to do.
