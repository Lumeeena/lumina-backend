# Schema Field Deprecation Policy

## Overview

When a schema field needs to be removed, it must first be marked as `@deprecated` with:
- A clear reason for deprecation
- The replacement field or alternative approach
- A minimum deprecation window before removal

## Deprecation Directive

Fields are marked using the standard GraphQL `@deprecated` directive:

```graphql
type Account {
  """
  The account's current sequence number.
  @deprecated(reason: "Use `sequenceNumber` instead for clearer naming. Removal planned for 2026-04-01.")
  """
  sequence: BigInt!

  """
  The account's current sequence number.
  """
  sequenceNumber: BigInt!
}
```

## Minimum Deprecation Window

- **Minimum window**: 90 days
- **Recommended window**: 180 days
- Removal is scheduled after the window expires only if usage metrics show low traffic

## Measuring Deprecated Field Usage

The GraphQL server tracks usage of deprecated fields via the `lumina_deprecated_field_usage_total` metric, labeled by:
- `field` - the deprecated field name
- `type` - the parent type name

Query the metric to determine when removal is safe:

```promql
# Usage rate of a specific deprecated field
rate(lumina_deprecated_field_usage_total{field="sequence"}[7d])

# Total deprecated field usage across all fields
sum(rate(lumina_deprecated_field_usage_total[7d]))
```

## Deprecation Process

1. **Add replacement field** (if one doesn't exist)
2. **Mark old field as @deprecated** with reason and removal date
3. **Document in CHANGELOG.md**
4. **Monitor usage metrics** for the deprecation window
5. **Remove field** only after:
   - Minimum window has elapsed
   - Usage is below threshold (e.g., < 1% of total requests)
   - Removal is announced in release notes

## Breaking Changes Without Deprecation

Fields may be removed without deprecation only in these cases:
- Security vulnerability
- Data integrity issue
- Feature was experimental and marked as such
