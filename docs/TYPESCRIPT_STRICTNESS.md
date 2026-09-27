# TypeScript Strict Compiler Options

This project uses strict TypeScript compiler options to catch bugs at compile time rather than runtime.

## Enabled Options

All options below are enabled in both `graphql-server/tsconfig.json` and `indexer/tsconfig.json`.

### Base Strictness

- **`strict: true`** — Enables all strict type checking options including:
  - `noImplicitAny` — Disallow variables and parameters without types
  - `noImplicitThis` — Disallow untyped `this` context
  - `strictNullChecks` — Disallow `null`/`undefined` in types without explicit opt-in
  - `strictFunctionTypes` — Enforce strict function type compatibility
  - `strictBindCallApply` — Enforce strict typing of `.bind()`, `.call()`, and `.apply()`
  - `strictPropertyInitialization` — Disallow uninitialized properties

### Additional Strictness

- **`noUncheckedIndexedAccess: true`** — Accessing object properties by string key can return `undefined`. This option requires checking or type narrowing before use. Critical for database result handling where a column might be missing.
- **`noImplicitOverride: true`** — Subclass methods must explicitly mark `override` when replacing parent methods. Catches bugs where a method signature changes.
- **`noPropertyAccessFromIndexSignature: true`** — Accessing properties via index signature (`obj[key]`) can return `undefined`; direct property access (`obj.prop`) requires the property to exist.
- **`exactOptionalPropertyTypes: true`** — Optional properties (`prop?: T`) must not be assigned `undefined` explicitly; only omission is allowed.
- **`noImplicitReturns: true`** — All code paths in a function must return a value (or throw).
- **`noFallthroughCasesInSwitch: true`** — Switch cases must end with `break` or `return` (no fallthrough).
- **`noUnusedLocals: true`** — Variables declared but not used are an error. Dead code is often a sign of a bug.
- **`noUnusedParameters: true`** — Function parameters not used in the body are an error. Use `_param` to mark intentionally unused parameters.
- **`forceConsistentCasingInFileNames: true`** — File imports must match the actual file case on disk. Prevents issues when moving between Linux (case-sensitive) and macOS/Windows (case-insensitive).
- **`isolatedModules: true`** — Treat each file as an isolated module. Catches issues with the transpiler that TypeScript alone might not surface.

## Why These Options

Database indexers are prone to a specific class of bug: accessing a column that might be `undefined` or `null`. For example:

```typescript
// Without strict options, this compiles:
const rows = await pool.query('SELECT id, optional_field FROM table');
for (const row of rows) {
  console.log(row.optional_field.toUpperCase()); // Runtime error if null
}

// With noUncheckedIndexedAccess, this fails to compile:
// Object is of type 'unknown'.ts(2571)
// OR if rows is typed as an array:
// Element implicitly has an 'any' type because expression of type 'number' can't be used to index type '{ id: string }'.

// Correct code:
for (const row of rows) {
  const field = row.optional_field;
  if (field != null) {
    console.log(field.toUpperCase());
  }
}
```

The same principle applies to optional fields, uninitialized properties, and fallthrough cases — catching them at compile time is cheaper than debugging them in production.

## Breaking the Rules

If you must disable an option for a specific file or function, use a `ts-expect-error` comment with an explanation:

```typescript
// @ts-expect-error: Legacy library has incorrect types; checked at runtime
const value = legacyLib.getValue();
```

If an entire file cannot comply with an option, disable it at the file level:

```typescript
// This file intentionally doesn't initialize all properties.
// @ts-nocheck
```

Please avoid this — it usually indicates a design issue worth fixing.

## Incrementally Enabling Strictness

If adding a new option breaks the build, enable it incrementally:

1. Enable the option in `tsconfig.json`
2. Add `ts-expect-error` suppressions to all affected lines
3. Fix the underlying issues
4. Remove the suppressions

This approach keeps the option enabled while making the failures actionable and trackable.
