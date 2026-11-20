"use client";

import { useMemo, type ReactNode } from "react";
import type { Adapter } from "@solana/wallet-adapter-base";
import type { ConnectionConfig } from "@solana/web3.js";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import "@solana/wallet-adapter-react-ui/styles.css";
import { getRpcEndpoint } from "@/lib/solana/constants";

/** Props for `SolanaProvider`. */
export interface SolanaProviderProps {
  children: ReactNode;
}

/** No explicit adapters: wallets that implement the Wallet Standard are detected automatically. */
const WALLET_ADAPTERS: Adapter[] = [];

/** Stable connection config; a new object each render would recreate the connection. */
const CONNECTION_CONFIG: ConnectionConfig = { commitment: "confirmed" };

/**
 * Supplies the Solana connection, wallet state and wallet selection modal to the app.
 *
 * Wallets are found through Wallet Standard autodetection and reconnect automatically on
 * page load once the user has chosen one.
 *
 * @param {SolanaProviderProps} props - Component props.
 * @param {ReactNode} props.children - Content that needs wallet or connection access.
 * @returns {React.JSX.Element} The provider tree.
 */
export function SolanaProvider({ children }: SolanaProviderProps): React.JSX.Element {
  const endpoint = useMemo(() => getRpcEndpoint(), []);
  return (
    <ConnectionProvider endpoint={endpoint} config={CONNECTION_CONFIG}>
      <WalletProvider wallets={WALLET_ADAPTERS} autoConnect>
        <WalletModalProvider>{children}</WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
