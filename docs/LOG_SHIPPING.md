# Shipping logs to an aggregator

Both services write structured JSON logs to stdout. Stdout is the default and
stays that way: nothing in the application changes to ship logs. This page says
how to get those lines into a log aggregator, which fields are worth indexing,
and what the field values mean.

Why this matters: a container's stdout is lost when the container is replaced,
which is exactly when the interesting logs were written. Logs need to leave the
container as they are written.

## What a line looks like

pino writes one JSON object per line. Values are fields, never interpolated into
the message, so they can be queried:

```json
{"level":30,"time":"2026-10-19T12:00:00.000Z","pid":1,"hostname":"indexer-1","service":"lumina-indexer","subsystem":"indexer","network":"mainnet","ledger":52481234,"msg":"ledger indexed"}
```

Fields that appear on every line:

| Field       | Meaning                                                                          |
| ----------- | -------------------------------------------------------------------------------- |
| `time`      | ISO-8601 timestamp, UTC. Use this as the event time, not the shipper's clock.    |
| `level`     | **Numeric** pino level: `10` trace, `20` debug, `30` info, `40` warn, `50` error, `60` fatal. |
| `service`   | `lumina-indexer` or `lumina-graphql`.                                            |
| `subsystem` | The module that logged, such as `horizon`, `retention`, `leader`, `indexer`.     |
| `msg`       | The human-readable message. Stable enough to group on.                           |
| `pid`, `hostname` | Set by pino. `hostname` is the container id, which separates replicas.    |

Fields that appear only on some lines, and are worth indexing when present:

| Field        | Where it comes from                                                              |
| ------------ | -------------------------------------------------------------------------------- |
| `network`    | Every indexer write and most lookups. Filter on it in multi-network deployments. |
| `ledger`     | Ledger-level progress and failures.                                              |
| `url`, `status`, `attempt`, `delay` | Horizon client retries and rate limits.                    |
| `field`      | A Horizon response that failed validation names the field that did not match.    |
| `raw`        | The start of a malformed Horizon response, truncated to 4 KB.                    |
| `err`        | An error message. The text is a field, so it can be grouped on.                  |
| `suppressed` | On a sampled success line, how many successes were dropped since the last one.   |
| `correlationId` | GraphQL requests that carry one.                                              |

Routine successes are sampled (`LOG_SAMPLE_RATE`, default `0.01`). Warnings and
errors are never sampled. A sampled stream therefore still shows the volume of
work through `suppressed`.

## Shipping without changing application code

Pick one of these. They are listed from least to most setup.

### 1. Container runtime log driver

Docker can send each container's stdout to a logging backend directly. Set the
driver on the service, for example with Compose:

```yaml
services:
  indexer:
    logging:
      driver: fluentd
      options:
        fluentd-address: "localhost:24224"
        tag: "lumina.{{.Name}}"
```

Other drivers (`gelf`, `awslogs`, `journald`) work the same way. The trade-off:
the driver sends lines as the daemon reads them, so a daemon outage can drop
lines, and the driver's buffer options matter. Check the driver's documentation
for `mode=non-blocking` and buffer limits before relying on it for audit-grade
logs.

### 2. A log-collector sidecar or agent

Run Fluent Bit (or Vector, or the OpenTelemetry Collector) on each host. It
reads the container runtime's log files, parses the JSON, and forwards it. The
application is unaware of it. A starting template is in
[`docker/observability/log-shipping/`](../docker/observability/log-shipping/),
which parses the Lumina lines and forwards them to a configurable output.

Only the Lumina containers are kept, selected by the `"service":"lumina-` text
in each line, so other containers on the host are not shipped.

The template has been written against Fluent Bit's documented syntax but has
not been run against a live Docker host from this repository. Run
`fluent-bit --dry-run -c <file>` against your version before deploying it.

## Fields to index

Index these in the aggregator. They are the ones a query needs:

1. `service`, `subsystem`, `level`: the basic filter.
2. `network`: separates chains in a multi-network deployment.
3. `msg`: groups repeated events, such as a rate-limit burst.
4. `ledger`: follows one ledger through the indexer.
5. `hostname`: separates replicas, which matters for the single-writer lock.

Avoid indexing `raw` and `msg` text as high-cardinality labels. In Loki-style
systems, label on `service`, `subsystem` and `network` only, and keep `ledger`
and `hostname` as structured metadata or filter at query time.

## Level mapping

Aggregators usually expect names, and pino emits numbers. Map them in the
shipper rather than in the application, so the application's output is the same
everywhere:

| pino `level` | name  |
| ------------ | ----- |
| 10           | trace |
| 20           | debug |
| 30           | info  |
| 40           | warn  |
| 50           | error |
| 60           | fatal |

The Fluent Bit template does this mapping.

## Related

- [`docs/INDEXER_CONTROL_FLOW.md`](INDEXER_CONTROL_FLOW.md): what the indexer logs at each step.
- [`docs/SLOS.md`](SLOS.md): which signals alerting uses. Logs are for diagnosis, not paging.
