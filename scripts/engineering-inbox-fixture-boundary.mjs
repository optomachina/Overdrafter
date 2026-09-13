import { types } from "node:util";

const TRUSTED_PROMISE = Promise;
const TRUSTED_PROMISE_PROTOTYPE = Promise.prototype;
const NATIVE_PROMISE_THEN = TRUSTED_PROMISE_PROTOTYPE.then;
const PROMISE_CONSTRUCTOR_DESCRIPTOR = Object.getOwnPropertyDescriptor(TRUSTED_PROMISE_PROTOTYPE, "constructor");
const PROMISE_SPECIES_DESCRIPTOR = Object.getOwnPropertyDescriptor(TRUSTED_PROMISE, Symbol.species);
const SNAPSHOT_LIMITS = Object.freeze({ array: 512, depth: 32, keys: 1024, nodes: 8192, string: 64 * 1024 });
const compareText = (left, right) => left.localeCompare(right, "en");

export function exactKeys(value, keys) {
  try {
    if (!value || typeof value !== "object" || types.isProxy(value) || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
    const actual = Reflect.ownKeys(value);
    if (actual.some((key) => typeof key !== "string")) return false;
    const expected = [...keys];
    actual.sort(compareText);
    expected.sort(compareText);
    if (actual.join("\0") !== expected.join("\0")) return false;
    return actual.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor && "value" in descriptor && descriptor.enumerable;
    });
  } catch {
    return false;
  }
}

export function sameData(value, expected, seen = new WeakSet()) {
  try {
    if (Object.is(value, expected)) return true;
    if (!value || !expected || typeof value !== "object" || typeof expected !== "object"
      || Object.getPrototypeOf(value) !== Object.getPrototypeOf(expected) || seen.has(value)) return false;
    seen.add(value);
    const actualKeys = Reflect.ownKeys(value);
    const expectedKeys = Reflect.ownKeys(expected);
    if (actualKeys.length !== expectedKeys.length
      || expectedKeys.some((key) => !actualKeys.includes(key))) return false;
    return expectedKeys.every((key) => {
      const actual = Object.getOwnPropertyDescriptor(value, key);
      const wanted = Object.getOwnPropertyDescriptor(expected, key);
      return actual && wanted && "value" in actual && "value" in wanted
        && sameData(actual.value, wanted.value, seen);
    });
  } catch {
    return false;
  }
}

export function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export function safeCall(action) {
  try {
    return { value: action() };
  } catch {
    return { failure: "adapter_error" };
  }
}

function sameDescriptor(value, expected) {
  if (!value || !expected) return value === expected;
  return value.configurable === expected.configurable && value.enumerable === expected.enumerable
    && value.get === expected.get && value.set === expected.set
    && value.value === expected.value && value.writable === expected.writable;
}

export function consumeExactNativePromise(value) {
  try {
    if (types.isProxy(value) || !types.isPromise(value)
      || Object.getPrototypeOf(value) !== TRUSTED_PROMISE_PROTOTYPE
      || Object.getOwnPropertyDescriptor(value, "constructor")
      || !sameDescriptor(Object.getOwnPropertyDescriptor(TRUSTED_PROMISE_PROTOTYPE, "constructor"),
        PROMISE_CONSTRUCTOR_DESCRIPTOR)
      || !sameDescriptor(Object.getOwnPropertyDescriptor(TRUSTED_PROMISE, Symbol.species),
        PROMISE_SPECIES_DESCRIPTOR)) return false;
    Reflect.apply(NATIVE_PROMISE_THEN, value, [() => undefined, () => undefined]);
    return true;
  } catch {
    return false;
  }
}

function dataDescriptor(value, key) {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor && descriptor.enumerable ? descriptor : null;
}

function snapshotArray(value, keys, state, depth) {
  if (Object.getPrototypeOf(value) !== Array.prototype) return null;
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  const length = lengthDescriptor?.value;
  if (!(lengthDescriptor && "value" in lengthDescriptor) || !Number.isSafeInteger(length)
    || length < 0 || length > SNAPSHOT_LIMITS.array || keys.length !== length + 1
    || keys.some((key) => typeof key !== "string") || !keys.includes("length")) return null;
  const output = [];
  for (let index = 0; index < length; index++) {
    const descriptor = dataDescriptor(value, String(index));
    if (!descriptor) return null;
    const child = snapshotData(descriptor.value, state, depth + 1);
    if (!child) return null;
    output.push(child.value);
  }
  return { value: output };
}

function snapshotObject(value, keys, state, depth) {
  if (![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || keys.length > SNAPSHOT_LIMITS.keys || keys.some((key) => typeof key !== "string")) return null;
  const output = {};
  for (const key of keys) {
    const descriptor = dataDescriptor(value, key);
    if (!descriptor) return null;
    const child = snapshotData(descriptor.value, state, depth + 1);
    if (!child) return null;
    Object.defineProperty(output, key, { value: child.value, enumerable: true, writable: true, configurable: true });
  }
  return { value: output };
}

export function snapshotData(value, state = null, depth = 0) {
  try {
    if (value === null || typeof value === "boolean") return { value };
    if (typeof value === "string" && value.length <= SNAPSHOT_LIMITS.string) return { value };
    if (typeof value === "number" && Number.isSafeInteger(value)) return { value };
    const traversal = state ?? { nodes: 0, seen: new WeakSet() };
    if (!value || typeof value !== "object" || types.isProxy(value)
      || depth > SNAPSHOT_LIMITS.depth || traversal.seen.has(value)
      || ++traversal.nodes > SNAPSHOT_LIMITS.nodes) return null;
    traversal.seen.add(value);
    const keys = Reflect.ownKeys(value);
    return Array.isArray(value)
      ? snapshotArray(value, keys, traversal, depth)
      : snapshotObject(value, keys, traversal, depth);
  } catch {
    return null;
  }
}
