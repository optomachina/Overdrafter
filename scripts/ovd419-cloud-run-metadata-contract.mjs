import { TARGET } from "./ovd419-job-diagnostic.mjs";
import { OVD410_PRODUCTION_CONTRACT as NETWORK } from "./xometry-stable-egress-contract.mjs";

const reject = () => { throw new Error("cloud_run_metadata_contract_rejected"); };
function requireValue(value) { if (!value) reject(); }
function shape(value, required, optional = []) {
  requireValue(value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype);
  requireValue(required.every(key => Object.hasOwn(value, key))
    && Object.keys(value).every(key => required.includes(key) || optional.includes(key)));
}

/** Validate the source-defined Cloud Run location/PZS labels; unknown keys reject. */
export function validateOvd419ResourceLabels(value) {
  shape(value, [], ["cloud.googleapis.com/location", "run.googleapis.com/satisfiesPzs"]);
  for (const [key, item] of Object.entries(value)) {
    requireValue(item === (key === "cloud.googleapis.com/location" ? TARGET.region : "true"));
  }
}

// Only the supported one-interface/two-string-field JSON grammar is admitted.
// Decode key tokens before comparing so duplicate decoded keys cannot disappear.
function networkInterface(value) {
  const stringToken = /"(?:[^"\\]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/y;
  let offset = 0;
  const whitespace = () => { while (/[ \t\r\n]/.test(value[offset] ?? "") && offset < value.length) offset += 1; };
  const punctuation = (expected) => {
    whitespace(); requireValue(value[offset] === expected); offset += 1;
  };
  const string = () => {
    whitespace(); stringToken.lastIndex = offset;
    const token = stringToken.exec(value); requireValue(token !== null);
    offset = stringToken.lastIndex;
    try { return JSON.parse(token[0]); } catch { reject(); }
  };
  punctuation("["); punctuation("{");
  const firstKey = string(); punctuation(":"); const firstValue = string();
  punctuation(",");
  const secondKey = string(); punctuation(":"); const secondValue = string();
  punctuation("}"); punctuation("]"); whitespace(); requireValue(offset === value.length);
  requireValue(firstKey !== secondKey
    && [firstKey, secondKey].every(key => ["network", "subnetwork"].includes(key)));
  return { [firstKey]: firstValue, [secondKey]: secondValue };
}

function attribution(value) {
  requireValue(typeof value === "string" && Buffer.byteLength(value) >= 1
    && Buffer.byteLength(value) <= 256 && !/[\u0000-\u001f\u007f]/.test(value));
}

/**
 * Validate source-defined Cloud Run annotations. Server attribution keys are
 * accepted only for a read-side resource root and never authorize an operation.
 */
export function validateOvd419ResourceAnnotations(value,
  { network = false, allowServerAttribution = false } = {}) {
  const routing = ["run.googleapis.com/network-interfaces", "run.googleapis.com/vpc-access-egress"];
  const fixed = {
    "run.googleapis.com/client-name": ["gcloud"],
    "run.googleapis.com/launch-stage": ["GA", "BETA"],
    "run.googleapis.com/execution-environment": ["gen2"],
  };
  const server = ["run.googleapis.com/creator", "run.googleapis.com/lastModifier"];
  const optional = [...Object.keys(fixed), "run.googleapis.com/client-version", "run.googleapis.com/operation-id"];
  if (allowServerAttribution) optional.push(...server);
  shape(value, network ? routing : [], optional);
  for (const [key, item] of Object.entries(value)) {
    if (Object.hasOwn(fixed, key)) requireValue(fixed[key].includes(item));
    else if (key === "run.googleapis.com/client-version") {
      requireValue(typeof item === "string" && /^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(item));
    } else if (key === "run.googleapis.com/operation-id") {
      requireValue(typeof item === "string"
        && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(item));
    } else if (server.includes(key)) attribution(item);
    else if (key === "run.googleapis.com/vpc-access-egress") requireValue(item === "all-traffic");
    else {
      requireValue(typeof item === "string" && item.length <= 1024);
      const entry = networkInterface(item);
      for (const [field, name, scope] of [["network", NETWORK.network, "global/networks"],
        ["subnetwork", NETWORK.subnet, `regions/${TARGET.region}/subnetworks`]]) {
        const resource = `projects/${TARGET.project}/${scope}/${name}`;
        requireValue([name, resource, `https://www.googleapis.com/compute/v1/${resource}`].includes(entry[field]));
      }
    }
  }
}

/** Validate the existing read/write template metadata grammar. */
export function validateOvd419TemplateMetadata(value, { network }) {
  shape(value, network ? ["annotations"] : [], network ? ["labels"] : ["labels", "annotations"]);
  if (value.labels !== undefined) validateOvd419ResourceLabels(value.labels);
  if (value.annotations !== undefined) validateOvd419ResourceAnnotations(value.annotations, { network });
}

/** Validate source-named server metadata on a full Service read. */
export function validateOvd419ServiceRootAnnotations(value, expectedUrl) {
  const required = ["run.googleapis.com/ingress", "run.googleapis.com/ingress-status", "run.googleapis.com/urls"];
  const optional = ["run.googleapis.com/operation-id", "serving.knative.dev/creator",
    "serving.knative.dev/lastModifier", "run.googleapis.com/minScale",
    "run.googleapis.com/scalingMode", "run.googleapis.com/invoker-iam-disabled"];
  shape(value, required, optional);
  requireValue(value[required[0]] === "all" && value[required[1]] === "all");
  let urls;
  try { urls = JSON.parse(value[required[2]]); } catch { reject(); }
  requireValue(Array.isArray(urls) && urls.length === 1 && urls[0] === expectedUrl);
  if (value[optional[0]] !== undefined) {
    requireValue(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value[optional[0]]));
  }
  for (const key of optional.slice(1, 3)) if (value[key] !== undefined) attribution(value[key]);
  if (value[optional[3]] !== undefined) requireValue(value[optional[3]] === "0");
  if (value[optional[4]] !== undefined) requireValue(value[optional[4]] === "automatic");
  if (value[optional[5]] !== undefined) requireValue(value[optional[5]] === "false");
}

/** Validate the closed source-defined metadata on a full Service template. */
export function validateOvd419ServiceTemplateMetadata(value) {
  shape(value, ["annotations", "labels"]);
  validateOvd419ResourceLabels(value.labels);
  const annotations = value.annotations;
  const routing = ["run.googleapis.com/network-interfaces", "run.googleapis.com/vpc-access-egress"];
  const service = ["autoscaling.knative.dev/maxScale", "run.googleapis.com/cpu-throttling",
    "run.googleapis.com/execution-environment"];
  const generic = ["run.googleapis.com/client-name", "run.googleapis.com/launch-stage",
    "run.googleapis.com/client-version", "run.googleapis.com/operation-id"];
  shape(annotations, [...routing, ...service], ["autoscaling.knative.dev/minScale", ...generic]);
  const shared = Object.fromEntries(Object.entries(annotations)
    .filter(([key]) => [...routing, ...generic, "run.googleapis.com/execution-environment"].includes(key)));
  validateOvd419ResourceAnnotations(shared, { network: true });
  requireValue(annotations[service[0]] === "1" && annotations[service[1]] === "false"
    && annotations[service[2]] === "gen2");
  if (annotations["autoscaling.knative.dev/minScale"] !== undefined) {
    requireValue(annotations["autoscaling.knative.dev/minScale"] === "0");
  }
}
