// Test support for the time-ratio tests of the hostile-input bounds (OVD-989).
//
// A ratio test asks "did 8 times the input cost about 8 times the time, or 64 times?". Measuring the small input
// first and the large one later lets a change in machine load between the two decide the ratio. These helpers
// measure the two pieces of work alternately, several rounds, and keep the fastest time of each: a loaded
// machine slows a run down and never speeds it up, and load that lasts through the rounds slows both pieces.

/** Milliseconds one call of `work` takes. */
function timeOnce(work: () => void): number {
  const started = performance.now();
  work();
  return performance.now() - started;
}

/**
 * The fastest time of `first` and of `second`, each run once per round, alternately, after one warm-up run of
 * each. The pair measured within a round is taken under the same load.
 */
export function fastestOfPair(first: () => void, second: () => void, rounds = 5): { first: number; second: number } {
  first();
  second();
  let fastestFirst = Number.POSITIVE_INFINITY;
  let fastestSecond = Number.POSITIVE_INFINITY;
  for (let round = 0; round < rounds; round += 1) {
    fastestFirst = Math.min(fastestFirst, timeOnce(first));
    fastestSecond = Math.min(fastestSecond, timeOnce(second));
  }
  return { first: fastestFirst, second: fastestSecond };
}

/**
 * How many times longer `large` takes than `small`, from the fastest times of alternating runs. The small time
 * is floored at `floorMs` so a few milliseconds of noise on a very fast piece of work cannot decide the ratio.
 */
export function slowdown(small: () => void, large: () => void, options: { rounds?: number; floorMs?: number } = {}): number {
  const { first, second } = fastestOfPair(small, large, options.rounds ?? 5);
  return second / Math.max(first, options.floorMs ?? 5);
}
