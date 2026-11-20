import { LAMPORTS_PER_SOL, type Connection, type PublicKey } from "@solana/web3.js";

/**
 * Reads an address's SOL balance at `confirmed` commitment.
 *
 * @param {Connection} connection - RPC connection for the target cluster.
 * @param {PublicKey} owner - Address to read.
 * @returns {Promise<number>} Balance in SOL (not lamports).
 * @throws {Error} If the RPC request fails.
 */
export async function getSolBalance(connection: Connection, owner: PublicKey): Promise<number> {
  try {
    const lamports = await connection.getBalance(owner, "confirmed");
    return lamports / LAMPORTS_PER_SOL;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read SOL balance for ${owner.toBase58()}: ${message}`, { cause: error });
  }
}
