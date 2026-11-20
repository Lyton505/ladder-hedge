import { Buffer } from "buffer";
import { Transaction, TransactionInstruction, type Connection, type PublicKey } from "@solana/web3.js";
import type { WalletContextState } from "@solana/wallet-adapter-react";
import type { HedgeReceipt } from "@/lib/hedge/types";
import { MEMO_PROGRAM_ID } from "./constants";
import { extractReceiptMemo, MAX_MEMO_BYTES } from "./receipt-memo";

/** Largest page size `getSignaturesForAddress` accepts. */
export const MAX_RECEIPT_LOOKUP = 1000;

/** The two wallet capabilities `sendHedgeReceipt` needs. */
export type ReceiptWallet = Pick<WalletContextState, "publicKey" | "sendTransaction">;

/**
 * Formats an unknown thrown value as a message.
 *
 * @param {unknown} error - The thrown value.
 * @returns {string} A readable message.
 */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Builds the single Memo instruction a receipt transaction carries.
 *
 * The signer is passed as the instruction's only key, so the Memo program verifies that
 * the wallet signed the receipt and logs its address next to the memo.
 *
 * @param {PublicKey} signer - Wallet public key that signs and pays for the receipt.
 * @param {string} memo - Receipt memo text.
 * @returns {TransactionInstruction} The Memo program instruction.
 * @throws {Error} If the memo is empty or not under 300 UTF-8 bytes.
 */
export function buildReceiptInstruction(signer: PublicKey, memo: string): TransactionInstruction {
  const data = Buffer.from(memo, "utf8");
  if (data.length === 0) {
    throw new Error("Receipt memo is empty.");
  }
  if (data.length >= MAX_MEMO_BYTES) {
    throw new Error(`Receipt memo is ${data.length} bytes; it must be under ${MAX_MEMO_BYTES}.`);
  }
  return new TransactionInstruction({
    programId: MEMO_PROGRAM_ID,
    keys: [{ pubkey: signer, isSigner: true, isWritable: false }],
    data,
  });
}

/**
 * Writes a hedge receipt on chain as a one-instruction Memo transaction and waits for it
 * to reach `confirmed` commitment.
 *
 * @param {Connection} connection - RPC connection for the target cluster.
 * @param {ReceiptWallet} wallet - Connected wallet; only `publicKey` and `sendTransaction` are used.
 * @param {string} memo - Receipt memo text, as built by `buildReceiptMemo`.
 * @returns {Promise<string>} The confirmed transaction signature.
 * @throws {Error} If the wallet is not connected, the user rejects the request, the RPC
 *   fails, or the transaction fails or expires before confirmation.
 */
export async function sendHedgeReceipt(connection: Connection, wallet: ReceiptWallet, memo: string): Promise<string> {
  const owner = wallet.publicKey;
  if (owner === null) {
    throw new Error("Wallet is not connected. Connect a wallet before recording a hedge receipt.");
  }
  let signature: string | null = null;
  try {
    const instruction = buildReceiptInstruction(owner, memo);
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
    const transaction = new Transaction({ feePayer: owner, blockhash, lastValidBlockHeight }).add(instruction);
    signature = await wallet.sendTransaction(transaction, connection);
    const confirmation = await connection.confirmTransaction(
      { signature, blockhash, lastValidBlockHeight },
      "confirmed",
    );
    if (confirmation.value.err !== null) {
      throw new Error(`transaction ${signature} failed: ${JSON.stringify(confirmation.value.err)}`);
    }
    return signature;
  } catch (error) {
    const sentNote = signature === null ? "" : ` (signature ${signature})`;
    throw new Error(`Failed to record hedge receipt${sentNote}: ${describeError(error)}`, { cause: error });
  }
}

/**
 * Lists the Ladder Hedge receipts an address has written, newest first.
 *
 * `limit` caps how many recent transactions of the address are inspected, not how many
 * receipts are returned: unrelated or failed transactions in that window are skipped.
 *
 * @param {Connection} connection - RPC connection for the target cluster.
 * @param {PublicKey} owner - Wallet address whose receipts to read.
 * @param {number} limit - Number of recent signatures to inspect, 1 to 1000.
 * @returns {Promise<HedgeReceipt[]>} Receipts with the RPC length tag removed, newest first.
 * @throws {Error} If `limit` is out of range or the RPC request fails.
 */
export async function listHedgeReceipts(
  connection: Connection,
  owner: PublicKey,
  limit: number,
): Promise<HedgeReceipt[]> {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_RECEIPT_LOOKUP) {
    throw new Error(`Receipt lookup limit must be an integer from 1 to ${MAX_RECEIPT_LOOKUP}; got ${limit}.`);
  }
  try {
    const signatures = await connection.getSignaturesForAddress(owner, { limit }, "confirmed");
    const receipts: HedgeReceipt[] = [];
    for (const info of signatures) {
      if (info.err !== null) {
        continue;
      }
      const memo = extractReceiptMemo(info.memo);
      if (memo === null) {
        continue;
      }
      receipts.push({
        signature: info.signature,
        memo,
        blockTime: info.blockTime ?? null,
        slot: info.slot,
      });
    }
    receipts.sort((a, b) => b.slot - a.slot);
    return receipts;
  } catch (error) {
    throw new Error(`Failed to load hedge receipts for ${owner.toBase58()}: ${describeError(error)}`, {
      cause: error,
    });
  }
}
