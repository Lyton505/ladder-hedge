import { clusterApiUrl, PublicKey } from "@solana/web3.js";

/** Solana clusters the app can be pointed at. */
export type SolanaCluster = "devnet" | "testnet" | "mainnet-beta";

/**
 * SPL Memo program id.
 *
 * This is the long-standing SPL Memo deployment (called "v2" in older SPL docs,
 * declared as `v3` in the current interface crate). It is the id the RPC node
 * recognises when it fills the `memo` field of `getSignaturesForAddress`, which
 * `listHedgeReceipts` depends on. The newer Pinocchio deployment
 * (Memo4c2pN8afCj432Lb7RMVKi9PbQnnW7ewFFaV3oAH) is deliberately not used.
 *
 * Verified against:
 * - https://www.solana-program.com/docs/memo (official Solana Program Library docs)
 * - https://github.com/solana-program/memo/blob/main/interface/src/lib.rs
 */
export const MEMO_PROGRAM_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

/** Version tag that starts every Ladder Hedge receipt memo. */
export const RECEIPT_PREFIX = "LH1";

/** Cluster used when `NEXT_PUBLIC_SOLANA_CLUSTER` is unset or not a known cluster. */
export const DEFAULT_SOLANA_CLUSTER: SolanaCluster = "devnet";

/**
 * Narrows an environment value to a known cluster name.
 *
 * Unknown or empty values fall back to devnet, so a typo never points the app at mainnet.
 *
 * @param {string | undefined} value - Raw value of `NEXT_PUBLIC_SOLANA_CLUSTER`.
 * @returns {SolanaCluster} The matching cluster, or devnet.
 */
function resolveCluster(value: string | undefined): SolanaCluster {
  const trimmed = value === undefined ? "" : value.trim();
  if (trimmed === "devnet" || trimmed === "testnet" || trimmed === "mainnet-beta") {
    return trimmed;
  }
  return DEFAULT_SOLANA_CLUSTER;
}

/**
 * Cluster the app reads balances from and writes receipts to.
 *
 * Read with a literal `process.env.NEXT_PUBLIC_...` reference so Next.js inlines it
 * into the client bundle at build time.
 */
export const SOLANA_CLUSTER: SolanaCluster = resolveCluster(process.env.NEXT_PUBLIC_SOLANA_CLUSTER);

/**
 * Returns the JSON RPC endpoint for the configured cluster.
 *
 * @returns {string} `NEXT_PUBLIC_SOLANA_RPC_URL` when set and non-empty, otherwise the
 *   public endpoint for `SOLANA_CLUSTER`.
 */
export function getRpcEndpoint(): string {
  const override = process.env.NEXT_PUBLIC_SOLANA_RPC_URL;
  if (override !== undefined && override.trim() !== "") {
    return override.trim();
  }
  return clusterApiUrl(SOLANA_CLUSTER);
}

/**
 * Builds a Solana Explorer link for a transaction on the configured cluster.
 *
 * @param {string} signature - Base58 transaction signature.
 * @returns {string} Explorer URL, with a `cluster` query parameter for non-mainnet clusters.
 */
export function explorerTxUrl(signature: string): string {
  const base = `https://explorer.solana.com/tx/${encodeURIComponent(signature)}`;
  if (SOLANA_CLUSTER === "mainnet-beta") {
    return base;
  }
  return `${base}?cluster=${SOLANA_CLUSTER}`;
}
