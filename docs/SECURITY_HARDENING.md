# Request hardening

All settings are environment variables on the GraphQL server. Defaults are safe for production and keep local development working.

| Variable | Default | Effect |
| --- | --- | --- |
| `GRAPHQL_MAX_DEPTH` | `10` | Maximum field nesting. `0` disables. |
| `GRAPHQL_MAX_COMPLEXITY` | `1000` | Maximum query cost. A field costs `1 + limit * cost(children)`, so nested lists multiply. `0` disables. |
| `GRAPHQL_INTROSPECTION` | off when `NODE_ENV=production`, otherwise on | Introspection and Apollo's landing page. Set `true` to deliberately publish the schema, `false` to hide it in development. |
| `ALLOWED_ORIGINS` | unset (any origin) | Comma-separated CORS allow-list, e.g. `https://app.example.com,https://admin.example.com`. **Set this in production.** `*` keeps allow-all. |
| `DB_STATEMENT_TIMEOUT_MS` | `15000` | Postgres `statement_timeout` on every pool connection (plus a client-side `query_timeout` 1s later). `0` disables. |
| `REQUEST_TIMEOUT_MS` | `30000` | HTTP requests still unanswered after this get a `504`. `0` disables. |

Over-budget queries are rejected before any resolver runs, with `QUERY_TOO_DEEP` or `QUERY_TOO_COMPLEX` and a message naming the budget. A query cancelled by the database returns a `QUERY_TIMEOUT` error, and its connection goes back to the pool.
