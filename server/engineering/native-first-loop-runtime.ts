import { createNativeArtifactRoute, type NativeArtifactRouteConfig } from "./native-artifact-route";
import { createNativePrivateSql } from "./native-private-sql";
import { createNativePrivateStorage } from "./native-private-storage";
import { prepareNativeArtifactInputs } from "./native-artifact-mapping";
import { createNativeResultBindingWriter, createNativeResultRuntime } from "./native-result-runtime";
import type { NativeFinalizationOptions } from "./native-result-finalization";

type InputPreparation = Omit<Parameters<typeof prepareNativeArtifactInputs>[0], "enabled" | "sql">;
/** Trusted server composition only. The artifact route is the sole HTTP member;
 * never expose the owner preparation/binding/finalization methods as worker RPCs.
 * Pool, provider authorization and signing bytes are explicit configuration, not
 * discovered from the environment. This module starts no listener or worker.
 */
export function createNativeFirstLoopRuntime(config: NativeArtifactRouteConfig & {
  receiptKey?: Uint8Array; now?: () => Date;
}) {
  const enabled = config.enabled === true;
  const { pool, storageOrigin, storageAuthorization, publicOrigin, storageVersionIdQualified, timeoutMs, fetch, outputBucket, now } = config;
  const key = config.receiptKey === undefined ? undefined : Buffer.from(config.receiptKey);
  const sql = createNativePrivateSql({ pool, enabled, timeoutMs });
  const storage = createNativePrivateStorage({ sql, storageOrigin, authorization: storageAuthorization,
    enabled, versionIdQualified: storageVersionIdQualified, timeoutMs, fetch });
  const artifactRoute = createNativeArtifactRoute({ pool, storageOrigin, storageAuthorization, publicOrigin,
    enabled, storageVersionIdQualified, timeoutMs, fetch, outputBucket });
  const admitResult = createNativeResultBindingWriter({ sql, enabled });
  const result = () => {
    if (!enabled) throw new Error("Native first-loop runtime disabled.");
    if (!key || key.byteLength < 32) throw new Error("Native finalization key unavailable.");
    return createNativeResultRuntime({ sql, storage, pool, key, enabled, now });
  };
  return Object.freeze({
    artifactRoute,
    prepareInputs: (input: InputPreparation) => prepareNativeArtifactInputs({ ...input, sql, enabled }),
    admitResult,
    async finalize(taskId: string, attemptId: string, options?: NativeFinalizationOptions) {
      return result().finalize(taskId, attemptId, options);
    },
    async replay(taskId: string, attemptId: string, options?: NativeFinalizationOptions) {
      return result().replay(taskId, attemptId, options);
    },
  });
}
