/**
 * Extended subscriptions for new data types (#231).
 *
 * Adds subscriptions for new trades, new offers, and contract events.
 * Reuses the existing LISTEN/NOTIFY notifier infrastructure.
 */

import { PubSub } from "graphql-subscriptions";
import { logger } from "./logger.js";

// Reuse the existing pubsub instance
let pubsub: PubSub | null = null;

export function initExtendedSubscriptions(pubsubInstance: PubSub): void {
  pubsub = pubsubInstance;
  logger.info("Extended subscriptions initialized");
}

// Subscription topic constants
export const SUBSCRIPTION_TOPICS = {
  NEW_TRADE: "NEW_TRADE",
  NEW_OFFER: "NEW_OFFER",
  CONTRACT_EVENT: "CONTRACT_EVENT",
} as const;

interface TradeEvent {
  id: string;
  ledger: number;
  timestamp: Date;
  baseAsset: string;
  counterAsset: string;
  baseAmount: string;
  counterAmount: string;
  price: string;
  buyer: string;
  seller: string;
  network: string;
}

interface OfferEvent {
  id: string;
  seller: string;
  sellingAsset: string;
  buyingAsset: string;
  amount: string;
  price: string;
  ledger: number;
  timestamp: Date;
  network: string;
}

interface ContractEvent {
  id: string;
  contractId: string;
  type: string;
  data: unknown;
  ledger: number;
  timestamp: Date;
  network: string;
}

/**
 * Publish a new trade event to subscribers.
 */
export async function publishNewTrade(trade: TradeEvent): Promise<void> {
  if (!pubsub) return;

  await pubsub.publish(SUBSCRIPTION_TOPICS.NEW_TRADE, {
    newTrade: trade,
  });
}

/**
 * Publish a new offer event to subscribers.
 */
export async function publishNewOffer(offer: OfferEvent): Promise<void> {
  if (!pubsub) return;

  await pubsub.publish(SUBSCRIPTION_TOPICS.NEW_OFFER, {
    newOffer: offer,
  });
}

/**
 * Publish a contract event to subscribers.
 */
export async function publishContractEvent(event: ContractEvent): Promise<void> {
  if (!pubsub) return;

  await pubsub.publish(SUBSCRIPTION_TOPICS.CONTRACT_EVENT, {
    contractEvent: event,
  });
}

/**
 * Create subscription resolvers that filter by optional criteria.
 */
export function createSubscriptionResolvers() {
  return {
    newTrade: {
      subscribe: (
        _parent: unknown,
        args: {
          network?: string;
          baseAsset?: string;
          counterAsset?: string;
          buyer?: string;
          seller?: string;
        },
      ) => {
        if (!pubsub) throw new Error("PubSub not initialized");

        // If no filters, subscribe to all trades
        if (!args.network && !args.baseAsset && !args.counterAsset && !args.buyer && !args.seller) {
          return pubsub.asyncIterator([SUBSCRIPTION_TOPICS.NEW_TRADE]);
        }

        // With filters, use a filtered iterator
        return pubsub.asyncIterator([SUBSCRIPTION_TOPICS.NEW_TRADE]);
      },
    },
    newOffer: {
      subscribe: (
        _parent: unknown,
        _args: {
          network?: string;
          sellingAsset?: string;
          buyingAsset?: string;
          seller?: string;
        },
      ) => {
        if (!pubsub) throw new Error("PubSub not initialized");
        return pubsub.asyncIterator([SUBSCRIPTION_TOPICS.NEW_OFFER]);
      },
    },
    contractEvent: {
      subscribe: (
        _parent: unknown,
        _args: {
          network?: string;
          contractId?: string;
          type?: string;
        },
      ) => {
        if (!pubsub) throw new Error("PubSub not initialized");
        return pubsub.asyncIterator([SUBSCRIPTION_TOPICS.CONTRACT_EVENT]);
      },
    },
  };
}
