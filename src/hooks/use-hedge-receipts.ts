import { useCallback, useEffect, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import type { HedgeReceipt } from "@/lib/hedge/types";
import { listHedgeReceipts } from "@/lib/solana/receipts";

/** Recent transactions of the wallet inspected for receipts. */
export const RECEIPT_LOOKUP_LIMIT = 50;

/** Value returned by {@link useHedgeReceipts}. */
export interface HedgeReceiptsState {
  /** Receipts read from chain for the connected wallet, newest first. Empty with no wallet. */
  receipts: HedgeReceipt[];
  loading: boolean;
  error: string | null;
  /** Reads the receipts again. */
  refresh: () => void;
}

/** One stored read, tagged with what it was read for. */
interface ReceiptsResult {
  requestKey: string;
  receipts: HedgeReceipt[];
  error: string | null;
}

/** Shared empty list, so consumers see a stable reference. */
const NO_RECEIPTS: HedgeReceipt[] = [];

/**
 * Reads the Ladder Hedge receipts the connected wallet has written, from its recent
 * transactions. Reads when a wallet connects, when it changes, and on `refresh`.
 *
 * @returns {HedgeReceiptsState} Receipts with loading and error states; empty when no wallet is connected.
 */
export function useHedgeReceipts(): HedgeReceiptsState {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const [refreshCount, setRefreshCount] = useState(0);
  const [result, setResult] = useState<ReceiptsResult | null>(null);

  const ownerKey = publicKey === null ? null : `${connection.rpcEndpoint}|${publicKey.toBase58()}`;
  const requestKey = ownerKey === null ? null : `${ownerKey}|${refreshCount}`;

  useEffect(() => {
    if (publicKey === null || requestKey === null) {
      return;
    }
    let cancelled = false;

    /**
     * Reads the receipts and stores the outcome unless superseded.
     *
     * @returns {Promise<void>} Resolves when stored; errors become state.
     */
    const load = async (): Promise<void> => {
      try {
        const receipts = await listHedgeReceipts(connection, publicKey, RECEIPT_LOOKUP_LIMIT);
        if (!cancelled) {
          setResult({ requestKey, receipts, error: null });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[use-hedge-receipts] ${message}`);
        if (!cancelled) {
          setResult({ requestKey, receipts: NO_RECEIPTS, error: message });
        }
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [connection, publicKey, requestKey]);

  /**
   * Reads the wallet's receipts from chain again.
   *
   * @returns {void}
   */
  const refresh = useCallback((): void => {
    setRefreshCount((count) => count + 1);
  }, []);

  const sameOwner = result !== null && ownerKey !== null && result.requestKey.startsWith(`${ownerKey}|`);
  const current = result !== null && result.requestKey === requestKey;

  return {
    receipts: sameOwner ? result.receipts : NO_RECEIPTS,
    loading: requestKey !== null && !current,
    error: current ? result.error : null,
    refresh,
  };
}
