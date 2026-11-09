import assert from "node:assert/strict";
import test from "node:test";
import { markedExitValueLamports } from "./strategy.ts";

test("marked exit value applies integer curve and transaction fees", () => {
  assert.equal(markedExitValueLamports(100n, 1_000_000n, 900n, 10n), 98_740n);
});

test("marked exit value preserves precision for amounts above Number's safe range", () => {
  assert.equal(
    markedExitValueLamports(
      9_007_199_254_740_993n,
      12_000_000_000_000_000_000n,
      9_000_000_000_000_000_000n,
      105_000n,
    ),
    11_847_621_919_601_125n,
  );
});

test("marked exit value subtracts the transaction fee for an empty holding", () => {
  assert.equal(markedExitValueLamports(0n, 1_000_000n, 900n, 10n), -10n);
});
