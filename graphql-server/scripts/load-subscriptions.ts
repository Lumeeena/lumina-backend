import { performance } from 'perf_hooks';
import { LedgerNotifier, SubscriberLimitError } from '../src/pubsub';

const subscribers = Number(process.env.SUBSCRIPTION_LOAD_SUBSCRIBERS ?? 500);
const queueLimit = Number(process.env.SUBSCRIPTION_LOAD_QUEUE_LIMIT ?? 64);
const notifications = Number(process.env.SUBSCRIPTION_LOAD_NOTIFICATIONS ?? queueLimit * 4);
const querySamples = Number(process.env.SUBSCRIPTION_LOAD_QUERY_SAMPLES ?? 200);

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[index] ?? 0;
}

async function measureQueryLatency(samples: number[]): Promise<void> {
  const start = performance.now();
  await new Promise(resolve => setImmediate(resolve));
  samples.push(performance.now() - start);
}

async function main() {
  const notifier = new LedgerNotifier({
    connectionString: 'postgresql://load-harness/not-used',
    maxSubscribers: subscribers,
    queueLimit,
  });

  const streams = Array.from({ length: subscribers }, () => notifier.subscribe());
  let capRejected = false;
  try {
    notifier.subscribe();
  } catch (err) {
    capRejected = err instanceof SubscriberLimitError;
  }

  const samples: number[] = [];
  for (let ledger = 1; ledger <= notifications; ledger++) {
    notifier.publish({ kind: 'ledger', ledger, transactions: 1, operations: 1 });
    if (samples.length < querySamples) await measureQueryLatency(samples);
  }

  const dropped = streams.reduce((sum, stream) => sum + stream.droppedCount(), 0);
  const result = {
    subscribers,
    queueLimit,
    notifications,
    querySamples: samples.length,
    queryLatencyMs: {
      p50: percentile(samples, 50),
      p95: percentile(samples, 95),
      max: Math.max(...samples),
    },
    capRejected,
    subscriberCountAtLimit: notifier.subscriberCount,
    droppedNotifications: dropped,
    expectedDroppedNotifications: Math.max(0, notifications - queueLimit) * subscribers,
  };

  for (const stream of streams) await stream.return?.();
  await notifier.stop();

  console.log(JSON.stringify(result, null, 2));

  if (!capRejected) throw new Error('subscription cap did not reject one subscriber past the limit');
  if (dropped !== result.expectedDroppedNotifications) {
    throw new Error(`buffer eviction mismatch: expected ${result.expectedDroppedNotifications}, got ${dropped}`);
  }
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
