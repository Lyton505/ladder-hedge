/**
 * Devnet integration tests for the receipt flow. Skipped unless explicitly enabled, so
 * `pnpm test` never touches the network.
 *
 *   LADDER_HEDGE_DEVNET_E2E=1 pnpm exec vitest run src/lib/solana/receipts.devnet.test.ts
 *
 * 1. Read-only check (needs no funds): the Memo program exists on devnet, the RPC formats
 *    its memos as `[length] text`, and the exact transaction `sendHedgeReceipt` builds
 *    executes successfully in a devnet simulation and logs the receipt memo.
 * 2. Full write: generates a throwaway keypair in memory (never read from or written to
 *    disk), funds it, sends a real receipt through `sendHedgeReceipt` with a small
 *    keypair-backed stand-in for the wallet adapter, then reads it back with
 *    `listHedgeReceipts` and `parseReceiptMemo`.
 *
 * Funding: the public devnet RPC faucet (`requestAirdrop`) may be closed or rate limited.
 * The test tries it with backoff. To fund by hand instead, also set
 * `LADDER_HEDGE_DEVNET_FUNDING_WAIT_S=300`: the test prints the throwaway address and
 * polls its balance while you send it devnet SOL from https://faucet.solana.com.
 *
 * Devnet only: both tests refuse to run if the app is configured for another cluster.
 */
import {
  clusterApiUrl,
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  Transaction,
  VersionedTransaction,
  type PublicKey,
} from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import type { Exposure, HedgePlan, HedgeReceipt } from "@/lib/hedge/types";
import { explorerTxUrl, MEMO_PROGRAM_ID, SOLANA_CLUSTER } from "./constants";
import { buildReceiptMemo, parseReceiptMemo } from "./receipt-memo";
import { buildReceiptInstruction, listHedgeReceipts, sendHedgeReceipt, type ReceiptWallet } from "./receipts";

const ENABLED = process.env.LADDER_HEDGE_DEVNET_E2E === "1";
const FUNDING_WAIT_S = Number(process.env.LADDER_HEDGE_DEVNET_FUNDING_WAIT_S ?? "0");
const DEVNET_URL = clusterApiUrl("devnet");
const AIRDROP_LAMPORTS = 0.5 * LAMPORTS_PER_SOL;
const AIRDROP_BACKOFF_MS = [0, 5_000, 15_000];
const MIN_FEE_LAMPORTS = 10_000;
const BALANCE_POLL_MS = 5_000;
const LIST_ATTEMPTS = 8;
const LIST_DELAY_MS = 2_000;
const BASE_TIMEOUT_MS = 180_000;

const EXPOSURE: Exposure = { asset: "SOL", quantity: 25, spot: 142.37 };

const PLAN: HedgePlan = {
  status: "optimal",
  legs: [
    { instrumentSymbol: "DEVNET-TEST-130", strike: 130, side: "yes", quantity: 40, price: 0.18, fee: 0.42, cost: 7.62 },
    { instrumentSymbol: "DEVNET-TEST-140", strike: 140, side: "no", quantity: 60, price: 0.41, fee: 1.02, cost: 25.62 },
  ],
  totalCost: 33.24,
  outcomes: [],
  worstCaseBefore: -900,
  worstCaseAfter: -400,
  expectedHedgePayout: 12.5,
  requestedMaxLoss: 400,
  stressPrice: 120,
};

/**
 * Waits for a number of milliseconds.
 *
 * @param {number} ms - Delay in milliseconds.
 * @returns {Promise<void>} Resolves after the delay.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

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
 * Requests and confirms a devnet airdrop, retrying with backoff.
 *
 * @param {Connection} connection - Devnet connection.
 * @param {PublicKey} recipient - Throwaway address to fund.
 * @returns {Promise<string[]>} An empty list on success, otherwise one message per failed attempt.
 */
async function tryAirdrop(connection: Connection, recipient: PublicKey): Promise<string[]> {
  const failures: string[] = [];
  for (const [attempt, backoff] of AIRDROP_BACKOFF_MS.entries()) {
    if (backoff > 0) {
      await sleep(backoff);
    }
    try {
      const latest = await connection.getLatestBlockhash("confirmed");
      const signature = await connection.requestAirdrop(recipient, AIRDROP_LAMPORTS);
      const result = await connection.confirmTransaction({ signature, ...latest }, "confirmed");
      if (result.value.err !== null) {
        throw new Error(`airdrop transaction failed: ${JSON.stringify(result.value.err)}`);
      }
      console.log(`Airdrop confirmed: ${signature}`);
      return [];
    } catch (error) {
      failures.push(`attempt ${attempt + 1}: ${describeError(error).trim()}`);
    }
  }
  return failures;
}

/**
 * Funds the throwaway address: airdrop first, then, if enabled, waits for a manual transfer.
 *
 * @param {Connection} connection - Devnet connection.
 * @param {PublicKey} recipient - Throwaway address to fund.
 * @returns {Promise<void>} Resolves once the address can pay fees.
 * @throws {Error} If the address is still unfunded after every option.
 */
async function fund(connection: Connection, recipient: PublicKey): Promise<void> {
  const failures = await tryAirdrop(connection, recipient);
  if (failures.length === 0) {
    return;
  }
  const deadline = Date.now() + FUNDING_WAIT_S * 1000;
  if (FUNDING_WAIT_S > 0) {
    console.log(
      `Airdrop failed. Send devnet SOL to ${recipient.toBase58()} from https://faucet.solana.com ` +
        `within ${FUNDING_WAIT_S} seconds.`,
    );
  }
  while (Date.now() < deadline) {
    try {
      const balance = await connection.getBalance(recipient, "confirmed");
      if (balance >= MIN_FEE_LAMPORTS) {
        console.log(`Funded manually: ${balance / LAMPORTS_PER_SOL} SOL`);
        return;
      }
    } catch (error) {
      console.log(`Balance poll failed, retrying: ${describeError(error)}`);
    }
    await sleep(BALANCE_POLL_MS);
  }
  throw new Error(`Could not fund ${recipient.toBase58()} on devnet:\n${failures.join("\n")}`);
}

/**
 * Wraps a keypair in the two wallet-adapter members `sendHedgeReceipt` uses. It signs and
 * submits the transaction the way a browser wallet does.
 *
 * @param {Keypair} keypair - Throwaway signer.
 * @returns {ReceiptWallet} Wallet stand-in.
 */
function keypairWallet(keypair: Keypair): ReceiptWallet {
  return {
    publicKey: keypair.publicKey,
    sendTransaction: async (transaction, connection) => {
      try {
        if (transaction instanceof VersionedTransaction) {
          transaction.sign([keypair]);
          return await connection.sendRawTransaction(transaction.serialize());
        }
        transaction.sign(keypair);
        return await connection.sendRawTransaction(transaction.serialize());
      } catch (error) {
        throw new Error(`Keypair wallet could not send the transaction: ${describeError(error)}`, { cause: error });
      }
    },
  };
}

/**
 * Finds a devnet address that can cover fees in a simulation, taken from the fee payer of
 * a recent Memo program transaction. Used only as the simulated fee payer and signer with
 * signature verification off: nothing is signed or submitted for it.
 *
 * @param {Connection} connection - Devnet connection.
 * @returns {Promise<PublicKey>} A funded address.
 * @throws {Error} If no recent fee payer has enough balance.
 */
async function findFundedAddress(connection: Connection): Promise<PublicKey> {
  try {
    const recent = await connection.getSignaturesForAddress(MEMO_PROGRAM_ID, { limit: 10 }, "confirmed");
    for (const info of recent) {
      const transaction = await connection.getTransaction(info.signature, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      });
      const feePayer = transaction?.transaction.message.staticAccountKeys[0];
      if (feePayer === undefined) {
        continue;
      }
      const balance = await connection.getBalance(feePayer, "confirmed");
      if (balance >= MIN_FEE_LAMPORTS) {
        return feePayer;
      }
    }
    throw new Error("no recent Memo fee payer has a balance");
  } catch (error) {
    throw new Error(`Could not find a funded devnet address for simulation: ${describeError(error)}`, {
      cause: error,
    });
  }
}

describe.skipIf(!ENABLED)("hedge receipts on devnet (integration)", () => {
  it(
    "Memo program, RPC memo format and receipt transaction simulation (read-only)",
    async () => {
      expect(SOLANA_CLUSTER).toBe("devnet");
      const connection = new Connection(DEVNET_URL, "confirmed");

      const programAccount = await connection.getAccountInfo(MEMO_PROGRAM_ID, "confirmed");
      expect(programAccount?.executable).toBe(true);
      console.log(`Memo program ${MEMO_PROGRAM_ID.toBase58()} is executable on devnet.`);

      const recent = await connection.getSignaturesForAddress(MEMO_PROGRAM_ID, { limit: 20 }, "confirmed");
      const sampleMemos = recent.map((info) => info.memo).filter((memo): memo is string => memo !== null);
      console.log(`Sample RPC memo fields: ${JSON.stringify(sampleMemos.slice(0, 3))}`);
      expect(sampleMemos.length).toBeGreaterThan(0);
      expect(sampleMemos.every((memo) => /^\[\d+\] /.test(memo))).toBe(true);

      const signer = await findFundedAddress(connection);
      const { memo } = await buildReceiptMemo("DEVNET-SIM-TEST", EXPOSURE, PLAN);
      const { blockhash } = await connection.getLatestBlockhash("confirmed");
      const legacy = new Transaction({ feePayer: signer, recentBlockhash: blockhash }).add(
        buildReceiptInstruction(signer, memo),
      );
      const simulation = await connection.simulateTransaction(new VersionedTransaction(legacy.compileMessage()), {
        sigVerify: false,
        replaceRecentBlockhash: true,
        commitment: "confirmed",
      });
      const logs = simulation.value.logs ?? [];
      console.log(`Simulation err: ${JSON.stringify(simulation.value.err)}\nSimulation logs:\n${logs.join("\n")}`);
      expect(simulation.value.err).toBeNull();
      expect(logs.some((line) => line.includes(memo))).toBe(true);
    },
    BASE_TIMEOUT_MS,
  );

  it(
    "writes a memo receipt and reads it back",
    async () => {
      expect(SOLANA_CLUSTER).toBe("devnet");
      const connection = new Connection(DEVNET_URL, "confirmed");
      const payer = Keypair.generate();
      console.log(`Throwaway devnet address: ${payer.publicKey.toBase58()}`);

      await fund(connection, payer.publicKey);

      const { memo, planHash } = await buildReceiptMemo("DEVNET-E2E-TEST", EXPOSURE, PLAN);
      const signature = await sendHedgeReceipt(connection, keypairWallet(payer), memo);
      console.log(`Receipt signature: ${signature}`);
      console.log(`Explorer: ${explorerTxUrl(signature)}`);

      const transaction = await connection.getTransaction(signature, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      });
      expect(transaction).not.toBeNull();
      const accountKeys = transaction?.transaction.message.staticAccountKeys.map((key) => key.toBase58()) ?? [];
      expect(accountKeys).toContain(MEMO_PROGRAM_ID.toBase58());
      const logs = transaction?.meta?.logMessages ?? [];
      console.log(`Program logs:\n${logs.join("\n")}`);
      expect(logs.some((line) => line.includes(memo))).toBe(true);

      let found: HedgeReceipt | null = null;
      for (let attempt = 0; attempt < LIST_ATTEMPTS && found === null; attempt += 1) {
        const receipts = await listHedgeReceipts(connection, payer.publicKey, 20);
        found = receipts.find((receipt) => receipt.signature === signature) ?? null;
        if (found === null) {
          await sleep(LIST_DELAY_MS);
        }
      }
      console.log(`listHedgeReceipts returned: ${JSON.stringify(found)}`);
      expect(found).not.toBeNull();
      expect(found?.memo).toBe(memo);

      const parsed = parseReceiptMemo(found?.memo ?? "");
      expect(parsed).toEqual(parseReceiptMemo(memo));
      expect(parsed?.planHash).toBe(planHash.slice(0, 32));
      expect(parsed?.eventTicker).toBe("DEVNET-E2E-TEST");
    },
    BASE_TIMEOUT_MS + Math.max(0, FUNDING_WAIT_S) * 1000,
  );
});
