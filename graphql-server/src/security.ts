/**
 * Request-hardening configuration and guards for the GraphQL endpoint:
 * query depth / cost limits, introspection, CORS and timeouts.
 *
 * Every knob is an environment variable with a default that is safe for
 * production and does not disturb local development. See docs/SECURITY_HARDENING.md.
 */
import type { ApolloServerPlugin } from '@apollo/server';
import { unwrapResolverError } from '@apollo/server/errors';
import type { CorsOptions } from 'cors';
import type { NextFunction, Request, Response } from 'express';
import {
  GraphQLError,
  Kind,
  getNamedType,
  getNullableType,
  getVariableValues,
  isCompositeType,
  isListType,
} from 'graphql';
import type {
  DocumentNode,
  FragmentDefinitionNode,
  GraphQLCompositeType,
  GraphQLFormattedError,
  GraphQLSchema,
  OperationDefinitionNode,
  SelectionSetNode,
} from 'graphql';
import { getArgumentValues } from 'graphql/execution/values';

export const DEFAULT_MAX_QUERY_DEPTH = 10;
export const DEFAULT_MAX_QUERY_COMPLEXITY = 1000;
export const DEFAULT_DB_STATEMENT_TIMEOUT_MS = 15_000;
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/** Parse a non-negative integer env var. Falls back on anything unusable. */
export function parseNonNegativeInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw.trim());
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

export function parseBool(raw: string | undefined): boolean | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const v = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  return undefined;
}

export interface SecurityConfig {
  maxDepth: number;
  maxComplexity: number;
  introspection: boolean;
  allowedOrigins: string[] | '*';
  statementTimeoutMs: number;
  requestTimeoutMs: number;
}

export function loadSecurityConfig(env: NodeJS.ProcessEnv = process.env): SecurityConfig {
  const production = env['NODE_ENV'] === 'production';
  const origins = (env['ALLOWED_ORIGINS'] ?? '')
    .split(',')
    .map(o => o.trim())
    .filter(Boolean);
  return {
    // 0 disables a limit.
    maxDepth: parseNonNegativeInt(env['GRAPHQL_MAX_DEPTH'], DEFAULT_MAX_QUERY_DEPTH),
    maxComplexity: parseNonNegativeInt(env['GRAPHQL_MAX_COMPLEXITY'], DEFAULT_MAX_QUERY_COMPLEXITY),
    // Off in production unless explicitly re-enabled with GRAPHQL_INTROSPECTION=true.
    introspection: parseBool(env['GRAPHQL_INTROSPECTION']) ?? !production,
    allowedOrigins: origins.length === 0 || origins.includes('*') ? '*' : origins,
    statementTimeoutMs: parseNonNegativeInt(env['DB_STATEMENT_TIMEOUT_MS'], DEFAULT_DB_STATEMENT_TIMEOUT_MS),
    requestTimeoutMs: parseNonNegativeInt(env['REQUEST_TIMEOUT_MS'], DEFAULT_REQUEST_TIMEOUT_MS),
  };
}

export function corsOptions(config: Pick<SecurityConfig, 'allowedOrigins'>): CorsOptions {
  return { origin: config.allowedOrigins === '*' ? true : config.allowedOrigins };
}

// ---------------------------------------------------------------------------
// Depth and cost analysis
// ---------------------------------------------------------------------------

export interface QueryAnalysis {
  depth: number;
  complexity: number;
}

/**
 * Measure an operation. Depth is the deepest field nesting. Complexity is the
 * sum of field costs where a field costs `1 + multiplier * cost(children)` and
 * the multiplier is the field's `limit` argument (schema default included), so
 * a nested list multiplies the work it fans out to. Introspection fields are
 * free and are not counted toward depth.
 */
export function analyzeOperation(
  schema: GraphQLSchema,
  operation: OperationDefinitionNode,
  fragments: Record<string, FragmentDefinitionNode>,
  rawVariables: Record<string, unknown> | undefined
): QueryAnalysis {
  const root =
    operation.operation === 'query'
      ? schema.getQueryType()
      : operation.operation === 'mutation'
        ? schema.getMutationType()
        : schema.getSubscriptionType();
  if (!root) return { depth: 0, complexity: 0 };

  const coerced = getVariableValues(schema, operation.variableDefinitions ?? [], rawVariables ?? {});
  const variables = coerced.coerced ?? {};

  const walk = (
    selectionSet: SelectionSetNode,
    parent: GraphQLCompositeType,
    depth: number,
    spreading: Set<string>
  ): QueryAnalysis => {
    let maxDepth = depth;
    let cost = 0;
    for (const sel of selectionSet.selections) {
      if (sel.kind === Kind.FIELD) {
        if (sel.name.value.startsWith('__')) continue;
        const fields = 'getFields' in parent ? parent.getFields() : {};
        const def = fields[sel.name.value];
        if (!def) continue;
        const named = getNamedType(def.type);
        let multiplier = 1;
        if (def.args.some(a => a.name === 'limit') || isListType(getNullableType(def.type))) {
          const limit = getArgumentValues(def, sel, variables)['limit'];
          if (typeof limit === 'number' && limit > 0) multiplier = limit;
        }
        let childCost = 0;
        let childDepth = depth + 1;
        if (sel.selectionSet && isCompositeType(named)) {
          const child = walk(sel.selectionSet, named, depth + 1, spreading);
          childCost = child.complexity;
          childDepth = child.depth;
        }
        maxDepth = Math.max(maxDepth, childDepth);
        cost += 1 + multiplier * childCost;
      } else {
        let target = parent;
        let set: SelectionSetNode;
        if (sel.kind === Kind.INLINE_FRAGMENT) {
          set = sel.selectionSet;
          const tc = sel.typeCondition && schema.getType(sel.typeCondition.name.value);
          if (tc && isCompositeType(tc)) target = tc;
        } else {
          const frag = fragments[sel.name.value];
          if (!frag || spreading.has(sel.name.value)) continue;
          set = frag.selectionSet;
          const tc = schema.getType(frag.typeCondition.name.value);
          if (tc && isCompositeType(tc)) target = tc;
        }
        const guard = sel.kind === Kind.FRAGMENT_SPREAD ? sel.name.value : undefined;
        if (guard) spreading.add(guard);
        // Fragments do not add a level of nesting.
        const inner = walk(set, target, depth, spreading);
        if (guard) spreading.delete(guard);
        maxDepth = Math.max(maxDepth, inner.depth);
        cost += inner.complexity;
      }
    }
    return { depth: maxDepth, complexity: cost };
  };

  return walk(operation.selectionSet, root, 0, new Set());
}

/** Throws if the operation is over budget. Exported so it can be tested without a server. */
export function assertWithinLimits(
  schema: GraphQLSchema,
  document: DocumentNode,
  operation: OperationDefinitionNode,
  variables: Record<string, unknown> | undefined,
  config: Pick<SecurityConfig, 'maxDepth' | 'maxComplexity'>
): void {
  const fragments: Record<string, FragmentDefinitionNode> = {};
  for (const def of document.definitions) {
    if (def.kind === Kind.FRAGMENT_DEFINITION) fragments[def.name.value] = def;
  }
  const { depth, complexity } = analyzeOperation(schema, operation, fragments, variables);
  if (config.maxDepth > 0 && depth > config.maxDepth) {
    throw new GraphQLError(
      `Query depth ${depth} exceeds the maximum allowed depth of ${config.maxDepth}`,
      { extensions: { code: 'QUERY_TOO_DEEP', depth, maxDepth: config.maxDepth } }
    );
  }
  if (config.maxComplexity > 0 && complexity > config.maxComplexity) {
    throw new GraphQLError(
      `Query complexity ${complexity} exceeds the maximum allowed complexity of ${config.maxComplexity}`,
      { extensions: { code: 'QUERY_TOO_COMPLEX', complexity, maxComplexity: config.maxComplexity } }
    );
  }
}

/**
 * Reject an over-budget operation after parsing and validation but before any
 * resolver, and so any database query, runs.
 */
export function queryLimitsPlugin(
  config: Pick<SecurityConfig, 'maxDepth' | 'maxComplexity'>
): ApolloServerPlugin<any> {
  return {
    async requestDidStart() {
      return {
        async didResolveOperation(ctx) {
          if (!ctx.operation) return;
          assertWithinLimits(ctx.schema, ctx.document, ctx.operation, ctx.request.variables, config);
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Timeouts
// ---------------------------------------------------------------------------

/** True for Postgres `statement_timeout` cancellation (57014) or the pg client's own query_timeout. */
export function isDatabaseTimeout(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: string; message?: string };
  return e.code === '57014' || /statement timeout|Query read timeout/i.test(e.message ?? '');
}

/** Surface a cancelled query as a clear, coded error instead of a generic internal error. */
export function formatTimeoutError(formatted: GraphQLFormattedError, error: unknown): GraphQLFormattedError {
  if (!isDatabaseTimeout(unwrapResolverError(error))) return formatted;
  return {
    ...formatted,
    message:
      'The query took too long and was cancelled. Narrow the request (smaller limit, fewer nested fields) and retry.',
    extensions: { ...formatted.extensions, code: 'QUERY_TIMEOUT' },
  };
}

/** Pool options enforcing the statement timeout server-side, with a client-side backstop. */
export function poolTimeoutOptions(config: Pick<SecurityConfig, 'statementTimeoutMs'>) {
  if (config.statementTimeoutMs <= 0) return {};
  return {
    statement_timeout: config.statementTimeoutMs,
    query_timeout: config.statementTimeoutMs + 1000,
  };
}

/** Answer 504 if a request is still unfinished after `timeoutMs`. */
export function requestTimeoutMiddleware(timeoutMs: number) {
  return (_req: Request, res: Response, next: NextFunction): void => {
    if (timeoutMs <= 0) return next();
    const timer = setTimeout(() => {
      if (res.headersSent) return;
      res.status(504).json({
        errors: [
          {
            message: `Request timed out after ${timeoutMs}ms`,
            extensions: { code: 'REQUEST_TIMEOUT' },
          },
        ],
      });
    }, timeoutMs);
    timer.unref?.();
    const clear = () => clearTimeout(timer);
    res.on('finish', clear);
    res.on('close', clear);
    next();
  };
}
