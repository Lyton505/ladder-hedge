/**
 * Test-only reference solver for the hedge engine. Not used by the app.
 *
 * It rebuilds the hedge model from the plan's definitions without importing
 * any engine helper, and solves both linear programs by brute-force vertex
 * enumeration instead of the simplex solver the engine uses. That is only
 * practical for tiny ladders (1 to 3 rungs, so at most 6 legs), which is all
 * the reference property test needs. Adapted from the independent reviewer's
 * scratch solver (review A).
 */
import type { HedgeRequest, LadderRung } from "@/lib/hedge/types";

/** A leg as the reference model sees it. */
export interface ReferenceLeg {
  rung: LadderRung;
  side: "yes" | "no";
  /** Purchase price per contract before fees. */
  price: number;
  /** price plus the linear taker fee. */
  unitCost: number;
  /** Cap rounded down to whole increments; Infinity when unlimited. */
  cap: number;
  /** pays[j] is true when the leg pays at state j's evaluation price. */
  pays: boolean[];
}

/** The reference hedge model for one request. */
export interface ReferenceModel {
  /** Evaluation prices: the stress price, then each strike. */
  evalPrices: number[];
  /** Unhedged P&L per state. */
  unhedged: number[];
  legs: ReferenceLeg[];
  /** Minimum unhedged P&L. */
  worstCaseBefore: number;
  /** -maxLoss. */
  floor: number;
  /** Sum over legs of (quantityIncrement + $0.01): how much rounding can cost any state. */
  roundingBound: number;
}

/** Feasibility tolerance per unit of right-hand side for the vertex check. */
const VERTEX_TOLERANCE = 1e-9;

/** Pivot magnitude below which a square system is treated as singular. */
const SINGULAR_PIVOT = 1e-12;

/**
 * Returns the median gap between adjacent strikes, or 1 percent of the strike for one rung.
 *
 * @param {number[]} strikes - Strikes, ascending.
 * @returns {number} The median gap.
 */
function referenceGap(strikes: number[]): number {
  const gaps: number[] = [];
  for (let index = 1; index < strikes.length; index += 1) {
    gaps.push(strikes[index] - strikes[index - 1]);
  }
  gaps.sort((left, right) => left - right);
  if (gaps.length === 0) {
    return 0.01 * strikes[0];
  }
  if (gaps.length % 2 === 1) {
    return gaps[(gaps.length - 1) / 2];
  }
  return (gaps[gaps.length / 2 - 1] + gaps[gaps.length / 2]) / 2;
}

/**
 * Builds the reference model from the plan's definitions, including the
 * stress rule from fix round 1: the requested stress price, else the lower of
 * (lowest strike - gap) and (spot - gap).
 *
 * @param {HedgeRequest} request - The request.
 * @returns {ReferenceModel} The model.
 */
export function buildReferenceModel(request: HedgeRequest): ReferenceModel {
  const strikes = request.ladder.rungs.map((rung) => rung.strike);
  const gap = referenceGap(strikes);
  const stress = request.stressPrice ?? Math.min(strikes[0] - gap, request.exposure.spot - gap);
  const evalPrices = [stress, ...strikes];
  const unhedged = evalPrices.map((price) => request.exposure.quantity * (price - request.exposure.spot));
  const legs: ReferenceLeg[] = [];
  for (const rung of request.ladder.rungs) {
    const options: ["yes" | "no", number | null, number | null][] = [
      ["yes", rung.yesAsk, rung.yesAskSize],
      ["no", rung.yesBid === null ? null : 1 - rung.yesBid, rung.yesBidSize],
    ];
    for (const [side, price, size] of options) {
      if (price === null) {
        continue;
      }
      const unitCost = price + request.takerFeeRate * price * (1 - price);
      if (unitCost >= 1) {
        continue;
      }
      const rawCap = size ?? request.assumedDepth;
      const cap =
        rawCap === null
          ? Number.POSITIVE_INFINITY
          : Math.floor(rawCap / rung.quantityIncrement + 1e-9) * rung.quantityIncrement;
      if (cap <= 0) {
        continue;
      }
      const pays = evalPrices.map((evalPrice) => (side === "yes" ? evalPrice >= rung.strike : evalPrice < rung.strike));
      legs.push({ rung, side, price, unitCost, cap, pays });
    }
  }
  const roundingBound = legs.reduce((total, leg) => total + leg.rung.quantityIncrement + 0.01, 0);
  return {
    evalPrices,
    unhedged,
    legs,
    worstCaseBefore: Math.min(...unhedged),
    floor: -request.maxLoss,
    roundingBound,
  };
}

/**
 * Solves a dense square linear system by Gauss-Jordan elimination with partial pivoting.
 *
 * @param {number[][]} matrix - Square coefficient matrix (not modified).
 * @param {number[]} rightHandSide - Right-hand side.
 * @returns {number[] | null} The solution, or null when the system is singular.
 */
function solveSquare(matrix: number[][], rightHandSide: number[]): number[] | null {
  const size = rightHandSide.length;
  const augmented = matrix.map((row, rowIndex) => [...row, rightHandSide[rowIndex]]);
  for (let column = 0; column < size; column += 1) {
    let pivotRow = column;
    for (let row = column + 1; row < size; row += 1) {
      if (Math.abs(augmented[row][column]) > Math.abs(augmented[pivotRow][column])) {
        pivotRow = row;
      }
    }
    if (Math.abs(augmented[pivotRow][column]) < SINGULAR_PIVOT) {
      return null;
    }
    const swap = augmented[column];
    augmented[column] = augmented[pivotRow];
    augmented[pivotRow] = swap;
    for (let row = 0; row < size; row += 1) {
      if (row === column) {
        continue;
      }
      const factor = augmented[row][column] / augmented[column][column];
      if (factor === 0) {
        continue;
      }
      for (let entry = column; entry <= size; entry += 1) {
        augmented[row][entry] -= factor * augmented[column][entry];
      }
    }
  }
  return augmented.map((row, rowIndex) => row[size] / row[rowIndex]);
}

/**
 * Lists every k-element subset of {0, ..., n - 1} in lexicographic order.
 *
 * @param {number} n - Set size.
 * @param {number} k - Subset size.
 * @returns {number[][]} The subsets; empty when k > n.
 */
function subsets(n: number, k: number): number[][] {
  const result: number[][] = [];
  if (k > n) {
    return result;
  }
  const indices = Array.from({ length: k }, (_unused, position) => position);
  for (;;) {
    result.push(indices.slice());
    let position = k - 1;
    while (position >= 0 && indices[position] === n - k + position) {
      position -= 1;
    }
    if (position < 0) {
      return result;
    }
    indices[position] += 1;
    for (let next = position + 1; next < k; next += 1) {
      indices[next] = indices[next - 1] + 1;
    }
  }
}

/**
 * Maximises objective . z subject to G z >= h by enumerating every vertex
 * (every choice of n tight rows) and keeping the best feasible one. Correct
 * for bounded problems whose feasible set has a vertex; tiny problems only.
 *
 * @param {number[]} objective - Objective coefficients, length n.
 * @param {number[][]} rows - Constraint rows G.
 * @param {number[]} bounds - Right-hand sides h.
 * @returns {{ value: number; point: number[] } | null} The optimum, or null when no feasible vertex exists.
 */
function vertexLp(objective: number[], rows: number[][], bounds: number[]): { value: number; point: number[] } | null {
  const variableCount = objective.length;
  let best: { value: number; point: number[] } | null = null;
  for (const chosen of subsets(rows.length, variableCount)) {
    const point = solveSquare(
      chosen.map((rowIndex) => rows[rowIndex]),
      chosen.map((rowIndex) => bounds[rowIndex]),
    );
    if (point === null) {
      continue;
    }
    let feasible = true;
    for (let rowIndex = 0; rowIndex < rows.length && feasible; rowIndex += 1) {
      let lhs = 0;
      for (let column = 0; column < variableCount; column += 1) {
        lhs += rows[rowIndex][column] * point[column];
      }
      if (lhs < bounds[rowIndex] - VERTEX_TOLERANCE * (1 + Math.abs(bounds[rowIndex]))) {
        feasible = false;
      }
    }
    if (!feasible) {
      continue;
    }
    let value = 0;
    for (let column = 0; column < variableCount; column += 1) {
      value += objective[column] * point[column];
    }
    if (best === null || value > best.value + 1e-12) {
      best = { value, point };
    }
  }
  return best;
}

/**
 * Reference stage 1: the minimum continuous cost such that every state's
 * hedged P&L (cost included) is at least floor + margin.
 *
 * @param {ReferenceModel} model - The reference model.
 * @param {number} [margin] - Extra dollars added to the floor; defaults to 0.
 * @returns {{ cost: number; quantities: number[] } | null} The optimum, or null when infeasible.
 */
export function referenceMinimumCost(model: ReferenceModel, margin = 0): { cost: number; quantities: number[] } | null {
  const legCount = model.legs.length;
  const target = model.floor + margin;
  if (legCount === 0) {
    return model.worstCaseBefore >= target ? { cost: 0, quantities: [] } : null;
  }
  const rows: number[][] = [];
  const bounds: number[] = [];
  model.unhedged.forEach((unhedged, stateIndex) => {
    rows.push(model.legs.map((leg) => (leg.pays[stateIndex] ? 1 : 0) - leg.unitCost));
    bounds.push(target - unhedged);
  });
  model.legs.forEach((leg, legIndex) => {
    const nonNegative = new Array<number>(legCount).fill(0);
    nonNegative[legIndex] = 1;
    rows.push(nonNegative);
    bounds.push(0);
    if (Number.isFinite(leg.cap)) {
      const capRow = new Array<number>(legCount).fill(0);
      capRow[legIndex] = -1;
      rows.push(capRow);
      bounds.push(-leg.cap);
    }
  });
  const optimum = vertexLp(
    model.legs.map((leg) => -leg.unitCost),
    rows,
    bounds,
  );
  if (optimum === null) {
    return null;
  }
  return { cost: -optimum.value, quantities: optimum.point };
}

/**
 * Reference stage 2: the maximum continuous worst-case hedged P&L t, with t a
 * free variable bounded above by a generous cap so the program stays bounded.
 *
 * @param {ReferenceModel} model - The reference model.
 * @returns {{ worstCase: number; quantities: number[] }} The best worst case and the quantities achieving it.
 * @throws {Error} If no feasible vertex exists, which cannot happen for a valid model.
 */
export function referenceMaximumWorstCase(model: ReferenceModel): { worstCase: number; quantities: number[] } {
  const legCount = model.legs.length;
  if (legCount === 0) {
    return { worstCase: model.worstCaseBefore, quantities: [] };
  }
  const worstCaseCap = Math.abs(model.worstCaseBefore) * 5 + Math.abs(model.floor) * 5 + 10;
  const rows: number[][] = [];
  const bounds: number[] = [];
  model.unhedged.forEach((unhedged, stateIndex) => {
    rows.push([...model.legs.map((leg) => (leg.pays[stateIndex] ? 1 : 0) - leg.unitCost), -1]);
    bounds.push(-unhedged);
  });
  model.legs.forEach((leg, legIndex) => {
    const nonNegative = new Array<number>(legCount + 1).fill(0);
    nonNegative[legIndex] = 1;
    rows.push(nonNegative);
    bounds.push(0);
    if (Number.isFinite(leg.cap)) {
      const capRow = new Array<number>(legCount + 1).fill(0);
      capRow[legIndex] = -1;
      rows.push(capRow);
      bounds.push(-leg.cap);
    }
  });
  const capRow = new Array<number>(legCount + 1).fill(0);
  capRow[legCount] = -1;
  rows.push(capRow);
  bounds.push(-worstCaseCap);
  const objective = new Array<number>(legCount + 1).fill(0);
  objective[legCount] = 1;
  const optimum = vertexLp(objective, rows, bounds);
  if (optimum === null) {
    throw new Error("Reference stage 2 found no feasible vertex, which is impossible for a valid model");
  }
  return { worstCase: optimum.value, quantities: optimum.point.slice(0, legCount) };
}
