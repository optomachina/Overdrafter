import { spawn } from "node:child_process";

export function pythonJson(python: string, script: string, input: unknown, timeoutMs: number, progress?: () => void, boundEnvironment?: NodeJS.ProcessEnv): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn(python, [script], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...boundEnvironment } });
    let output = ""; let errors = ""; let settled = false;
    const fail = () => { if (!settled) { settled = true; clearTimeout(timer); reject(new Error("Local adapter did not complete; inspect retained run")); } };
    // Do not kill SolidWorks or infer rollback from timeout. Dispatcher keeps its lock.
    const timer = setTimeout(fail, timeoutMs);
    child.on("error", fail); child.stdin.on("error", fail);
    child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); if (output.length > 1_000_000) fail(); });
    child.stderr.on("data", (chunk: Buffer) => {
      if (settled) { return; }
      errors += chunk.toString();
      if (errors.includes("PLATE_VERIFYING")) { progress?.(); errors = ""; }
      if (errors.length > 64_000) fail();
    });
    child.on("close", code => {
      if (settled) { return; }
      clearTimeout(timer); settled = true;
      if (code !== 0) { reject(new Error("Local adapter failed")); return; }
      try { resolve(JSON.parse(output)); } catch { reject(new Error("Invalid local adapter response")); }
    });
    child.stdin.end(JSON.stringify(input));
  });
}
