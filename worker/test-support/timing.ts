// Test support for the time-ratio tests of the hostile-input bounds (OVD-989).
//
// A ratio test asks "did 8 times the input cost about 8 times the time, or 64 times?". Two things let machine load
// decide that ratio instead of the code. Measuring the small input first and the large one later lets a change in
// load between the two decide it; and on a machine with more runnable processes than cores, wall time inflates a
// long piece of work (it is descheduled many times) more than a short one (it often finishes inside one time
// slice). These helpers therefore measure the two pieces of work alternately, several rounds, keep the fastest of
// each, and measure CPU time (user plus system) instead of wall time: a process that is waiting for a core uses
// none. A loaded machine slows a run down and never speeds it up, so the fastest round is the least disturbed.

/** CPU milliseconds (user plus system, of the whole process) one call of `work` takes. */
function cpuMsOnce(work: () => void): number {
  const before = process.cpuUsage();
  work();
  const used = process.cpuUsage(before);
  return (used.user + used.system) / 1000;
}

/**
 * The fastest CPU time of `first` and of `second`, each run once per round, alternately, after one warm-up run of
 * each. The pair measured within a round is taken under the same load.
 */
export function fastestOfPair(first: () => void, second: () => void, rounds = 5): { first: number; second: number } {
  first();
  second();
  let fastestFirst = Number.POSITIVE_INFINITY;
  let fastestSecond = Number.POSITIVE_INFINITY;
  for (let round = 0; round < rounds; round += 1) {
    fastestFirst = Math.min(fastestFirst, cpuMsOnce(first));
    fastestSecond = Math.min(fastestSecond, cpuMsOnce(second));
  }
  return { first: fastestFirst, second: fastestSecond };
}

/**
 * How many times longer `large` takes than `small`, from the fastest CPU times of alternating runs. The small time
 * is floored at `floorMs` so a few milliseconds of noise on a very fast piece of work cannot decide the ratio.
 */
export function slowdown(small: () => void, large: () => void, options: { rounds?: number; floorMs?: number } = {}): number {
  const { first, second } = fastestOfPair(small, large, options.rounds ?? 5);
  return second / Math.max(first, options.floorMs ?? 5);
}
