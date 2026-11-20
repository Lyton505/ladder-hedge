import { useCallback, useEffect, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { getSolBalance } from "@/lib/solana/balance";

/** Value returned by `useSolBalance`. */
export interface SolBalanceState {
  /** Balance in SOL, or null when no wallet is connected or no read has succeeded yet. */
  balance: number | null;
  loading: boolean;
  error: string | null;
  /** Re-reads the balance. */
  refresh: () => void;
}

/** Outcome of one balance read, tagged with what it was read for. */
interface BalanceResult {
  /** Endpoint and owner address the read was for. */
  ownerKey: string;
  /** Endpoint, owner address and refresh counter the read was for. */
  requestKey: string;
  balance: number | null;
  error: string | null;
}

/**
 * Reads the connected wallet's SOL balance from the provider's connection.
 *
 * The balance is read when a wallet connects, when the connected wallet or endpoint
 * changes, and whenever `refresh` is called. During a refresh the last balance for the
 * same wallet stays visible while `loading` is true.
 *
 * @returns {SolBalanceState} Balance in SOL, loading flag, error message and a refresh function.
 */
export function useSolBalance(): SolBalanceState {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const [refreshCount, setRefreshCount] = useState(0);
  const [result, setResult] = useState<BalanceResult | null>(null);

  const ownerKey = publicKey === null ? null : `${connection.rpcEndpoint}|${publicKey.toBase58()}`;
  const requestKey = ownerKey === null ? null : `${ownerKey}|${refreshCount}`;

  useEffect(() => {
    if (publicKey === null || ownerKey === null || requestKey === null) {
      return;
    }
    let cancelled = false;

    /**
     * Reads the balance and stores the outcome unless the effect was superseded.
     *
     * @returns {Promise<void>} Resolves once the outcome is stored; errors become state.
     */
    const load = async (): Promise<void> => {
      try {
        const balance = await getSolBalance(connection, publicKey);
        if (!cancelled) {
          setResult({ ownerKey, requestKey, balance, error: null });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!cancelled) {
          setResult({ ownerKey, requestKey, balance: null, error: message });
        }
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [connection, publicKey, ownerKey, requestKey]);

  /**
   * Reads the wallet's SOL balance again.
   *
   * @returns {void}
   */
  const refresh = useCallback((): void => {
    setRefreshCount((count) => count + 1);
  }, []);

  const sameOwner = result !== null && ownerKey !== null && result.ownerKey === ownerKey;
  const current = sameOwner && result.requestKey === requestKey;

  return {
    balance: sameOwner ? result.balance : null,
    loading: requestKey !== null && !current,
    error: current ? result.error : null,
    refresh,
  };
}
