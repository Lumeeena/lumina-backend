/**
 * Lumina GraphQL API Load Test Harness
 *
 * This harness provides a basic way to load-test the GraphQL API.
 * It sends a specified number of concurrent queries and measures response times
 * and success rates.
 *
 * To run this load test, you would typically:
 * 1. Ensure the GraphQL server is running and accessible (e.g., at http://localhost:4000/graphql).
 * 2. Execute this script with a tool like `ts-node` or compile it and run with `node`.
 *    e.g., `ts-node graphql-server/src/loadtest.ts <concurrency> <numRequests>`
 *
 * This is a standalone harness and does not integrate with the main server or its metrics.
 */

import { performance } from 'perf_hooks';
import { URL } from 'url';
import { subsystem } from './logger';

const log = subsystem('loadtest');

const GRAPHQL_URL = process.env.GRAPHQL_URL ?? 'http://localhost:4000/graphql';

// A sample GraphQL query to use for the load test.
// This query fetches the latest 20 transactions.
const SAMPLE_QUERY = `
  query LatestTransactions {
    transactions(limit: 20) {
      items {
        hash
        ledger
        sourceAccount
        operations {
          id
          type
        }
      }
      pageInfo {
        hasNextPage
        cursor
      }
    }
  }
`;

async function sendGraphQLQuery(): Promise<{ success: boolean; duration: number }> {
  const startTime = performance.now();
  try {
    const response = await fetch(GRAPHQL_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: SAMPLE_QUERY }),
    });
    const duration = performance.now() - startTime;

    if (response.ok) {
      const jsonResponse = await response.json();
      if (jsonResponse.errors) {
        log.warn({ errors: jsonResponse.errors }, 'GraphQL query returned errors');
        return { success: false, duration };
      }
      return { success: true, duration };
    } else {
      log.error({ status: response.status, statusText: response.statusText }, 'HTTP error');
      return { success: false, duration };
    }
  } catch (err) {
    const duration = performance.now() - startTime;
    log.error({ err: err instanceof Error ? err.message : String(err) }, 'Failed to send GraphQL query');
    return { success: false, duration };
  }
}

async function runLoadTest(concurrency: number, numRequests: number) {
  log.info({ concurrency, numRequests, graphqlUrl: GRAPHQL_URL }, 'Starting GraphQL API load test');

  let successfulRequests = 0;
  let failedRequests = 0;
  const durations: number[] = [];
  const startTime = performance.now();

  const activeRequests = new Set<Promise<void>>();

  for (let i = 0; i < numRequests; i++) {
    if (activeRequests.size >= concurrency) {
      await Promise.race(activeRequests);
    }

    const requestPromise = sendGraphQLQuery().then(result => {
      if (result.success) {
        successfulRequests++;
        durations.push(result.duration);
      } else {
        failedRequests++;
      }
      activeRequests.delete(requestPromise);
    });
    activeRequests.add(requestPromise);
  }

  await Promise.all(activeRequests); // Wait for all remaining requests to complete

  const endTime = performance.now();
  const totalDurationMs = endTime - startTime;

  const averageDuration = durations.length > 0 ? durations.reduce((a, b) => a + b, 0) / durations.length : 0;
  const medianDuration = durations.length > 0
    ? durations.sort((a, b) => a - b)[Math.floor(durations.length / 2)]
    : 0;

  log.info({
    successfulRequests,
    failedRequests,
    totalRequests: numRequests,
    totalDurationMs: totalDurationMs.toFixed(2),
    averageDurationMs: averageDuration.toFixed(2),
    medianDurationMs: medianDuration.toFixed(2),
    requestsPerSecond: (numRequests / (totalDurationMs / 1000)).toFixed(2),
  }, 'Load test complete');
}

// Command-line argument parsing
const args = process.argv.slice(2);
const concurrency = parseInt(args[0], 10);
const numRequests = parseInt(args[1], 10);

if (isNaN(concurrency) || isNaN(numRequests) || concurrency <= 0 || numRequests <= 0) {
  console.error('Usage: ts-node graphql-server/src/loadtest.ts <concurrency> <numRequests>');
  process.exit(1);
}

runLoadTest(concurrency, numRequests).catch(err => {
  log.fatal({ err: err instanceof Error ? err.message : String(err) }, 'Load test failed fatally');
  process.exit(1);
});
