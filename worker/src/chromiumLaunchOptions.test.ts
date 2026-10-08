// @vitest-environment node

import fs from "node:fs/promises";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { chromiumSandboxLaunchOptions } from "./chromiumLaunchOptions";

// Service and job launchers that honor PLAYWRIGHT_DISABLE_SANDBOX.
const DEPLOYED_CHROMIUM_LAUNCHERS = [
  "adapters/fictiv.ts",
  "adapters/providerPortalKernel.ts",
  "adapters/xometry.ts",
  "tools/probeXometryProfileAuth.ts",
];

// The headed operator auth tools and the synthetic browser-recovery comparison
// harness ignore PLAYWRIGHT_DISABLE_SANDBOX, so Playwright launches them with
// --no-sandbox. Whether they should request the sandbox is decided in OVD-610.
// Changing this list also needs the worker README exception list updated.
const UNSANDBOXED_OPERATOR_LAUNCHERS = [
  "recovery/comparison.ts",
  "tools/fictivAuth.ts",
  "tools/vendorAuth.ts",
  "tools/xometryAuth.ts",
];

const BROWSER_PACKAGE = /^(?:playwright|patchright|playwright-core)(?:\/.*)?$/;
const LAUNCH_METHODS = new Set(["launch", "launchPersistentContext", "launchServer", "connectOverCDP"]);
const NON_CHROMIUM_BROWSER_TYPES = new Set(["firefox", "webkit"]);
// Launch options that would override what the helper returns.
const SANDBOX_OVERRIDE_KEYS = new Set(["args", "chromiumSandbox", "ignoreDefaultArgs"]);
const SANDBOX_HELPER = "chromiumSandboxLaunchOptions";

type GuardCheck = { guarded: boolean; overrides: string[] };
type Declaration = ts.VariableDeclaration | ts.FunctionDeclaration | ts.ParameterDeclaration;

const UNGUARDED: GuardCheck = { guarded: false, overrides: [] };

function stringLiteralText(node: ts.Node | undefined): string | undefined {
  return node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : undefined;
}

function isBrowserPackage(node: ts.Node | undefined): boolean {
  return BROWSER_PACKAGE.test(stringLiteralText(node) ?? "");
}

/** True for any import, re-export, require or dynamic import of a browser package that can carry a value. */
function isBrowserValueImport(node: ts.Node): boolean {
  if (ts.isImportDeclaration(node)) {
    if (!isBrowserPackage(node.moduleSpecifier)) return false;
    const clause = node.importClause;
    if (!clause) return true;
    if (clause.isTypeOnly) return false;
    if (clause.name) return true;
    const bindings = clause.namedBindings;
    if (!bindings || ts.isNamespaceImport(bindings)) return true;
    return bindings.elements.some((element) => !element.isTypeOnly);
  }
  if (ts.isExportDeclaration(node)) return !node.isTypeOnly && isBrowserPackage(node.moduleSpecifier);
  if (ts.isImportEqualsDeclaration(node)) {
    return !node.isTypeOnly
      && ts.isExternalModuleReference(node.moduleReference)
      && isBrowserPackage(node.moduleReference.expression);
  }
  if (ts.isCallExpression(node)) {
    const isRequire = ts.isIdentifier(node.expression) && node.expression.text === "require";
    const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
    return (isRequire || isDynamicImport) && isBrowserPackage(node.arguments[0]);
  }
  return false;
}

function forEachDescendant(node: ts.Node, visit: (node: ts.Node) => void): void {
  ts.forEachChild(node, (child) => {
    visit(child);
    forEachDescendant(child, visit);
  });
}

/** Lexical lookup of a plain identifier in its own file (not imports or destructured names). */
function resolveIdentifier(identifier: ts.Identifier): Declaration | undefined {
  const name = identifier.text;
  for (let scope: ts.Node | undefined = identifier.parent; scope; scope = scope.parent) {
    if (ts.isFunctionLike(scope)) {
      const parameter = scope.parameters.find((p) => ts.isIdentifier(p.name) && p.name.text === name);
      if (parameter) return parameter;
    }
    if (ts.isBlock(scope) || ts.isSourceFile(scope) || ts.isModuleBlock(scope) || ts.isCaseClause(scope)) {
      for (const statement of scope.statements) {
        if (ts.isFunctionDeclaration(statement) && statement.name?.text === name) return statement;
        if (ts.isVariableStatement(statement)) {
          const declaration = statement.declarationList.declarations
            .find((d) => ts.isIdentifier(d.name) && d.name.text === name);
          if (declaration) return declaration;
        }
      }
    }
  }
  return undefined;
}

/** Identifiers that read a value, not property names or object keys. */
function isValueReference(identifier: ts.Identifier): boolean {
  const parent = identifier.parent;
  if (ts.isPropertyAccessExpression(parent) && parent.name === identifier) return false;
  if ((ts.isPropertyAssignment(parent) || ts.isMethodDeclaration(parent)) && parent.name === identifier) return false;
  return true;
}

function propertyKey(property: ts.ObjectLiteralElementLike): string | undefined {
  const name = property.name;
  return name && (ts.isIdentifier(name) || ts.isStringLiteral(name)) ? name.text : undefined;
}

/**
 * Whether an expression carries the helper's result: it calls the helper, or
 * reads a same-file variable, function or parameter whose value does. Object
 * literal keys that would override the helper are collected on the way.
 */
function checkGuard(node: ts.Node, sourceFile: ts.SourceFile, seen = new Set<ts.Node>()): GuardCheck {
  const result: GuardCheck = { guarded: false, overrides: [] };
  const visit = (current: ts.Node) => {
    if (ts.isCallExpression(current) && ts.isIdentifier(current.expression)
      && current.expression.text === SANDBOX_HELPER) {
      result.guarded = true;
    }
    if (ts.isObjectLiteralExpression(current)) {
      for (const property of current.properties) {
        const key = propertyKey(property);
        if (key && SANDBOX_OVERRIDE_KEYS.has(key)) result.overrides.push(key);
      }
    }
    if (ts.isIdentifier(current) && isValueReference(current)) {
      const declaration = resolveIdentifier(current);
      if (declaration && !seen.has(declaration)) {
        seen.add(declaration);
        const inner = checkDeclaration(declaration, sourceFile, seen);
        result.guarded ||= inner.guarded;
        result.overrides.push(...inner.overrides);
      }
    }
  };
  visit(node);
  forEachDescendant(node, visit);
  return result;
}

/**
 * A parameter counts only when its function is stored in a variable (directly,
 * or as the fallback of `??`/`||`) and every call of that variable in the file
 * passes a guarded argument in that position.
 */
function checkParameter(parameter: ts.ParameterDeclaration, sourceFile: ts.SourceFile, seen: Set<ts.Node>): GuardCheck {
  const fn = parameter.parent;
  if (!ts.isArrowFunction(fn) && !ts.isFunctionExpression(fn)) return UNGUARDED;
  let holder: ts.Node = fn;
  while (ts.isParenthesizedExpression(holder.parent)
    || (ts.isBinaryExpression(holder.parent) && holder.parent.right === holder
      && (holder.parent.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
        || holder.parent.operatorToken.kind === ts.SyntaxKind.BarBarToken))) {
    holder = holder.parent;
  }
  const variable = holder.parent;
  if (!ts.isVariableDeclaration(variable) || !ts.isIdentifier(variable.name)) return UNGUARDED;
  const index = fn.parameters.indexOf(parameter);
  const checks: GuardCheck[] = [];
  forEachDescendant(sourceFile, (node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)
      && resolveIdentifier(node.expression) === variable) {
      const argument = node.arguments[index];
      checks.push(argument ? checkGuard(argument, sourceFile, seen) : UNGUARDED);
    }
  });
  return {
    guarded: checks.length > 0 && checks.every((check) => check.guarded),
    overrides: checks.flatMap((check) => check.overrides),
  };
}

function checkDeclaration(declaration: Declaration, sourceFile: ts.SourceFile, seen: Set<ts.Node>): GuardCheck {
  if (ts.isVariableDeclaration(declaration)) {
    return declaration.initializer ? checkGuard(declaration.initializer, sourceFile, seen) : UNGUARDED;
  }
  if (ts.isFunctionDeclaration(declaration)) {
    return declaration.body ? checkGuard(declaration.body, sourceFile, seen) : UNGUARDED;
  }
  return checkParameter(declaration, sourceFile, seen);
}

/** Local names an import binds to Playwright's firefox or webkit browser types. */
function nonChromiumBindings(sourceFile: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      if (NON_CHROMIUM_BROWSER_TYPES.has((element.propertyName ?? element.name).text)) names.add(element.name.text);
    }
  }
  return names;
}

function launchCall(node: ts.Node): { receiver: ts.Expression; method: string } | undefined {
  if (!ts.isCallExpression(node)) return undefined;
  const callee = node.expression;
  let method: string | undefined;
  if (ts.isPropertyAccessExpression(callee)) method = callee.name.text;
  else if (ts.isElementAccessExpression(callee)) method = stringLiteralText(callee.argumentExpression);
  else return undefined;
  return method && LAUNCH_METHODS.has(method) ? { receiver: callee.expression, method } : undefined;
}

function isNonChromiumReceiver(receiver: ts.Expression, nonChromium: Set<string>): boolean {
  if (ts.isIdentifier(receiver)) return nonChromium.has(receiver.text);
  return ts.isPropertyAccessExpression(receiver) && NON_CHROMIUM_BROWSER_TYPES.has(receiver.name.text);
}

type BrowserSourceReport = {
  browserImport: boolean;
  launchSites: number;
  unguardedChromiumLaunches: string[];
  overriddenChromiumLaunches: string[];
};

/**
 * Looks at every `.launch(`, `.launchPersistentContext(`, `.launchServer(` and
 * `.connectOverCDP(` call, dotted or bracketed. A call counts as Chromium
 * unless its receiver is an imported `firefox`/`webkit` binding or a
 * `.firefox`/`.webkit` property.
 */
function inspectBrowserSource(relative: string, source: string): BrowserSourceReport {
  const sourceFile = ts.createSourceFile(relative, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const nonChromium = nonChromiumBindings(sourceFile);
  const report: BrowserSourceReport = {
    browserImport: false,
    launchSites: 0,
    unguardedChromiumLaunches: [],
    overriddenChromiumLaunches: [],
  };
  forEachDescendant(sourceFile, (node) => {
    if (isBrowserValueImport(node)) report.browserImport = true;
    const call = launchCall(node);
    if (!call || !ts.isCallExpression(node)) return;
    report.launchSites += 1;
    if (isNonChromiumReceiver(call.receiver, nonChromium)) return;
    const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    const site = `${relative}:${line + 1}`;
    const checks = node.arguments.map((argument) => checkGuard(argument, sourceFile));
    if (!checks.some((check) => check.guarded)) report.unguardedChromiumLaunches.push(site);
    const overrides = checks.flatMap((check) => check.overrides);
    if (overrides.length > 0) report.overriddenChromiumLaunches.push(`${site} (${overrides.join(", ")})`);
  });
  return report;
}

function fileOfSite(site: string): string {
  return site.replace(/:\d+(?: .*)?$/, "");
}

describe("chromiumSandboxLaunchOptions", () => {
  it("requests the Chromium sandbox explicitly unless it is disabled", () => {
    expect(chromiumSandboxLaunchOptions({
      playwrightDisableSandbox: false,
      playwrightDisableDevShmUsage: false,
    })).toEqual({ args: [], chromiumSandbox: true });
    expect(chromiumSandboxLaunchOptions({
      playwrightDisableSandbox: false,
      playwrightDisableDevShmUsage: true,
    })).toEqual({ args: ["--disable-dev-shm-usage"], chromiumSandbox: true });
  });

  it("keeps the explicit opt-out flags when PLAYWRIGHT_DISABLE_SANDBOX is set", () => {
    expect(chromiumSandboxLaunchOptions({
      playwrightDisableSandbox: true,
      playwrightDisableDevShmUsage: true,
    })).toEqual({
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
      chromiumSandbox: false,
    });
  });

  it("routes every Chromium launch call through the helper, except in the listed operator launchers", async () => {
    // Playwright adds --no-sandbox whenever chromiumSandbox is not true, so a
    // Chromium launch that skips the helper, or overrides what it returns,
    // silently keeps the sandbox off. This check parses each source and looks
    // at every launch call site; the per-launcher tests check the values passed.
    const sources = (await fs.readdir(import.meta.dirname, { recursive: true }))
      .filter((relative) => relative.endsWith(".ts") && !relative.endsWith(".test.ts"))
      .sort();
    const browserImporters: string[] = [];
    const importersWithoutLaunch: string[] = [];
    const unguardedLaunches: string[] = [];
    const overriddenLaunches: string[] = [];
    const handBuilt: string[] = [];
    for (const relative of sources) {
      const source = await fs.readFile(path.join(import.meta.dirname, relative), "utf8");
      if (relative !== "chromiumLaunchOptions.ts" && source.includes("\"--no-sandbox\"")) {
        handBuilt.push(relative);
      }
      const report = inspectBrowserSource(relative, source);
      if (report.browserImport) {
        browserImporters.push(relative);
        // A file that imports a browser package without launching could hand
        // the browser type to another file, out of this check's sight.
        if (report.launchSites === 0) importersWithoutLaunch.push(relative);
      }
      unguardedLaunches.push(...report.unguardedChromiumLaunches);
      overriddenLaunches.push(...report.overriddenChromiumLaunches);
    }
    expect(browserImporters).toEqual(expect.arrayContaining([
      ...DEPLOYED_CHROMIUM_LAUNCHERS,
      ...UNSANDBOXED_OPERATOR_LAUNCHERS,
    ]));
    expect(importersWithoutLaunch).toEqual([]);
    expect([...new Set(unguardedLaunches.map(fileOfSite))]).toEqual(UNSANDBOXED_OPERATOR_LAUNCHERS);
    expect(overriddenLaunches.filter((site) => !UNSANDBOXED_OPERATOR_LAUNCHERS.includes(fileOfSite(site))))
      .toEqual([]);
    expect(handBuilt).toEqual([]);
  });
});
