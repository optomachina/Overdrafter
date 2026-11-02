// One worker, isolation off, files in name order: a-leaks runs before b-reads.
import { BaseSequencer } from "vitest/node";

class ByName extends BaseSequencer {
  async sort(files) {
    return [...files].sort((a, b) => a.moduleId.localeCompare(b.moduleId));
  }
}

export default {
  test: {
    root: import.meta.dirname,
    include: ["*.fixture.mjs"],
    environment: "node",
    isolate: false,
    maxWorkers: 1,
    minWorkers: 1,
    testTimeout: 1_000,
    setupFiles: ["../../per-file-reset.setup.mjs"],
    sequence: { sequencer: ByName },
  },
};
