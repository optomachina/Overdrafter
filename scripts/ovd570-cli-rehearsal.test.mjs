// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { rehearseCliRestore } from "./ovd570-cli-rehearsal.mjs";

it("reconciles and removes an owned restore container after an uncertain create reply", () => {
  const output=mkdtempSync(join(tmpdir(),"ovd570-create-"));
  const save=vi.fn();
  const call=vi.fn((args) => {
    if(args[0]==="run") throw new Error("create_reply_lost");
    if(args[0]==="inspect") return {status:0,stdout:"owned-fixture\n"};
    if(args[0]==="rm") return {status:0,stdout:""};
    throw new Error("unexpected_call");
  });
  try {
    expect(() => rehearseCliRestore({call,container:"source",fixtureId:"owned-fixture",output,save})).toThrow("create_reply_lost");
    expect(call.mock.calls.some(([args]) => args[0]==="rm" && args[2]==="source-restore")).toBe(true);
    expect(save.mock.calls[0][1].cleanup).toBe("removed_owned");
  } finally { rmSync(output,{recursive:true,force:true}); }
});
