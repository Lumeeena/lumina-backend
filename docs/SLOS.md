# Service Level Objectives (SLOs)

## Overview

This document defines the Service Level Objectives (SLOs) for the Lumina backend services. SLOs are target values for metrics that the service aims to meet, with error budgets derived from them.

## API Availability

### Objective
- **Target**: 99.9% availability (0.1% error budget = 43.2 minutes/month)
- **Measurement**: Successful GraphQL operations / total GraphQL operations
- **Metric**: `lumina_graphql_operations_total{outcome="ok"}`

### Error Budget
- Monthly error budget: 43.2 minutes of downtime
- Current alert: `GraphQLErrorRateHigh` at 5% error rate for 10 minutes
- SLO-aligned alert: Alert when error budget is projected to be exhausted

## API Latency

### Objective
- **Target**: 95th percentile latency < 500ms for read operations
- **Target**: 95th percentile latency < 2s for write operations
- **Measurement**: `lumina_graphql_operation_duration_seconds` histogram
- **Service-level**: p95 latency over 30-minute windows

### Error Budget
- Latency SLO is treated as a soft target
- Current alert: No specific latency alert exists
- Recommended alert: Alert when p95 latency exceeds 2s for 5 minutes

## Indexing Freshness

### Objective
- **Target**: Indexing lag < 20 ledgers (typically < 2 minutes on mainnet)
- **Measurement**: `lumina_indexing_lag_ledgers` gauge
- **Service-level**: Lag over 5-minute windows

### Error Budget
- Indexing lag is a freshness metric, not a strict availability metric
- Current alert: `IndexingLagHigh` at 20 ledgers for 5 minutes
- This aligns with the SLO target

## Horizon Availability

### Objective
- **Target**: Horizon rate limit responses < 0.1% of requests
- **Measurement**: `lumina_horizon_requests_total{status="429"}` rate
- **Service-level**: Rate over 5-minute windows

### Error Budget
- Current alert: `HorizonRateLimited` at >0.1 requests/sec for 5 minutes
- This aligns with the SLO target

## Database Availability

### Objective
- **Target**: Database pool exhaustion < 0.1% of time
- **Measurement**: `lumina_db_pool_waiting` gauge
- **Service-level**: Time spent with waiting clients

### Error Budget
- Current alert: `DatabasePoolExhausted` when waiting > 0 for 5 minutes
- This aligns with the SLO target

## Error Budget Calculation

Error budgets are calculated monthly:

```
Monthly error budget = (1 - SLO) × (days in month) × 24 × 60 minutes
```

For 99.9% availability:
- 30-day month: 43.2 minutes
- 31-day month: 44.64 minutes

## Alert Alignment

Current alerts in `docker/observability/alerts.yml` are aligned with SLOs:

| Alert | SLO | Status |
|-------|-----|--------|
| IndexingStalled | Indexing freshness | Aligned |
| IndexingLagHigh | Indexing freshness | Aligned (20 ledgers) |
| HorizonRateLimited | Horizon availability | Aligned |
| IndexingErrorRateHigh | Indexing reliability | Needs alignment |
| DatabasePoolErrors | Database availability | Aligned |
| DatabasePoolExhausted | Database availability | Aligned |
| GraphQLErrorRateHigh | API availability | Aligned (5% threshold) |

## Recommendations

1. **API Latency**: Add a latency alert based on the p95 objective
2. **Error Budget Burn Rate**: Implement burn rate alerts for API availability
3. **SLO Dashboards**: Create Grafana dashboards visualizing SLO compliance
4. **Weekly Reporting**: Automate weekly SLO compliance reports

## Measuring SLO Compliance

Use Prometheus queries to measure SLO compliance:

```promql
# API availability (last 7 days)
sum(rate(lumina_graphql_operations_total{outcome="ok"}[7d])) 
  / sum(rate(lumina_graphql_operations_total[7d]))

# Indexing freshness (p95 over last hour)
histogram_quantile(0.95, rate(lumina_indexing_lag_ledgers[1h]))

# API latency p95 (last hour)
histogram_quantile(0.95, 
  sum(rate(lumina_graphql_operation_duration_seconds_bucket[1h])) by (le))
```
