import "@testing-library/jest-dom/vitest";
import { afterEach, beforeAll, vi } from "vitest";

function createStorage() {
  const values = new Map<string, string>();

  return {
    get length() {
      return values.size;
    },
    clear() {
      values.clear();
    },
    getItem(key: string) {
      return values.get(String(key)) ?? null;
    },
    key(index: number) {
      return [...values.keys()][index] ?? null;
    },
    removeItem(key: string) {
      values.delete(String(key));
    },
    setItem(key: string, value: string) {
      values.set(String(key), String(value));
    },
  } satisfies Storage;
}

const originalEmitWarning = process.emitWarning.bind(process);

beforeAll(() => {
  const localStorage = createStorage();
  const sessionStorage = createStorage();

  vi.stubGlobal("__APP_VERSION__", "0.0.1-test");
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: localStorage,
  });
  Object.defineProperty(window, "sessionStorage", {
    configurable: true,
    value: sessionStorage,
  });
  vi.stubGlobal("localStorage", localStorage);
  vi.stubGlobal("sessionStorage", sessionStorage);

  process.emitWarning = ((warning: string | Error, ...args: unknown[]) => {
    const message = typeof warning === "string" ? warning : warning.message;
    if (message.includes("--localstorage-file") && message.includes("without a valid path")) {
      return;
    }

    return originalEmitWarning(warning as never, ...(args as []));
  }) as typeof process.emitWarning;
});

afterEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
});
