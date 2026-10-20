/**
 * @lumina/client: a typed client for the Lumina GraphQL API.
 *
 *   import { createLuminaClient, TransactionsDocument } from '@lumina/client';
 *
 *   const lumina = createLuminaClient({ url: 'https://api.example.com/graphql', apiKey });
 *   const { transactions } = await lumina.request(TransactionsDocument, { limit: 10 });
 *   transactions.items[0]?.hash; // string, typed from the schema
 *
 * The documents, their variables and result types are generated from the
 * server's schema (src/generated/graphql.ts); see docs/CLIENT_SDK.md.
 */
export * from './client';
export * from './generated/graphql';
