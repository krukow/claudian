import ts from 'typescript';

/**
 * Modules whose import means the source can start a process. `cross-spawn` is included
 * because it is the repository's own portable wrapper around `child_process`.
 */
const PROCESS_MODULES = new Set(['child_process', 'node:child_process', 'cross-spawn']);

/** The `child_process` entry points that start a process. */
const SPAWN_APIS = new Set([
  'exec',
  'execFile',
  'execFileSync',
  'execSync',
  'fork',
  'spawn',
  'spawnSync',
]);

function normalizeModuleName(moduleName) {
  return PROCESS_MODULES.has(moduleName) ? moduleName.replace(/^node:/, '') : null;
}

/**
 * The module a call names, or `unresolvable` when the specifier is not a literal the gate
 * can read. `require`, a dynamic `import`, and `process.getBuiltinModule` all hand out the
 * same module, the last of them without an import a bundler would ever see. A specifier
 * the gate cannot read could name anything, including `child_process`, so it is never
 * silently accepted.
 */
function readRequiredModule(node) {
  if (!ts.isCallExpression(node)) return null;
  const namesModule = isRequireCallee(node.expression)
    || node.expression.kind === ts.SyntaxKind.ImportKeyword
    || isBuiltinModuleCallee(node.expression);
  if (!namesModule) return null;

  const [specifier] = node.arguments;
  if (!specifier || !ts.isStringLiteralLike(specifier)) return 'unresolvable';
  return normalizeModuleName(specifier.text);
}

/** `require(...)`, and the same function reached through an object such as `globalThis`. */
function isRequireCallee(callee) {
  if (ts.isIdentifier(callee)) return callee.text === 'require';
  return ts.isPropertyAccessExpression(callee) && callee.name.text === 'require';
}

/**
 * `process.getBuiltinModule(...)`, however the source reaches it: through `globalThis`,
 * or destructured off `process` and called on its own.
 */
function isBuiltinModuleCallee(callee) {
  if (ts.isIdentifier(callee)) return callee.text === 'getBuiltinModule';
  return ts.isPropertyAccessExpression(callee) && callee.name.text === 'getBuiltinModule';
}

function createBindings() {
  return {
    /** Local name -> the process API it can be called as directly. */
    apis: new Map(),
    /** Process modules the source pulls in, however it does so. */
    imports: new Set(),
    /** Local names that stand for a process module accessed through its members. */
    namespaces: new Set(),
    /** Every name the source declares, so a local `fork` is not the Node one. */
    declared: new Set(),
    /** True once the source names a module through something the gate cannot read. */
    unresolvableModule: false,
  };
}

/**
 * The binding a `require` or dynamic `import` result is assigned to, so
 * `const { spawn } = require('child_process')` and `const cp = require('child_process')`
 * are both recorded.
 */
function findEnclosingBinding(node) {
  let current = node.parent;
  while (current && (ts.isAwaitExpression(current) || ts.isParenthesizedExpression(current))) {
    current = current.parent;
  }
  return current && ts.isVariableDeclaration(current) ? current.name : null;
}

function bindRequiredNames(bindingName, moduleName, bindings) {
  if (ts.isIdentifier(bindingName)) {
    if (moduleName === 'cross-spawn') bindings.apis.set(bindingName.text, 'spawn');
    bindings.namespaces.add(bindingName.text);
    return;
  }
  if (!ts.isObjectBindingPattern(bindingName)) return;
  for (const element of bindingName.elements) {
    if (!ts.isIdentifier(element.name)) continue;
    const api = (element.propertyName ?? element.name).getText();
    if (SPAWN_APIS.has(api) || moduleName === 'cross-spawn') {
      bindings.apis.set(element.name.text, api);
    }
  }
}

function bindImportClause(importClause, moduleName, bindings) {
  if (!importClause) return;
  if (importClause.name) {
    if (moduleName === 'cross-spawn') bindings.apis.set(importClause.name.text, 'spawn');
    bindings.namespaces.add(importClause.name.text);
  }

  const named = importClause.namedBindings;
  if (!named) return;
  if (ts.isNamespaceImport(named)) {
    bindings.namespaces.add(named.name.text);
    return;
  }
  for (const element of named.elements) {
    const api = (element.propertyName ?? element.name).text;
    if (SPAWN_APIS.has(api) || moduleName === 'cross-spawn') {
      bindings.apis.set(element.name.text, api);
    }
  }
}

function declareBindingName(bindingName, bindings) {
  if (!bindingName) return;
  if (ts.isIdentifier(bindingName)) {
    bindings.declared.add(bindingName.text);
    return;
  }
  if (ts.isObjectBindingPattern(bindingName) || ts.isArrayBindingPattern(bindingName)) {
    for (const element of bindingName.elements) {
      if (ts.isBindingElement(element)) declareBindingName(element.name, bindings);
    }
  }
}

function declareImportClause(importClause, bindings) {
  if (!importClause) return;
  if (importClause.name) bindings.declared.add(importClause.name.text);
  const named = importClause.namedBindings;
  if (!named) return;
  if (ts.isNamespaceImport(named)) {
    bindings.declared.add(named.name.text);
    return;
  }
  for (const element of named.elements) bindings.declared.add(element.name.text);
}

function collectBindings(sourceFile) {
  const bindings = createBindings();

  const visit = (node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
      const moduleName = normalizeModuleName(node.moduleSpecifier.text);
      if (moduleName) {
        bindings.imports.add(moduleName);
        bindImportClause(node.importClause, moduleName, bindings);
      }
      declareImportClause(node.importClause, bindings);
    }

    // A re-export pulls the module in exactly as an import does, and hands its API on.
    if (
      ts.isExportDeclaration(node)
      && node.moduleSpecifier
      && ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      const moduleName = normalizeModuleName(node.moduleSpecifier.text);
      if (moduleName) bindings.imports.add(moduleName);
    }

    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const specifier = node.moduleReference.expression;
      const moduleName = ts.isStringLiteralLike(specifier)
        ? normalizeModuleName(specifier.text)
        : 'unresolvable';
      if (moduleName === 'unresolvable') bindings.unresolvableModule = true;
      else if (moduleName) {
        bindings.imports.add(moduleName);
        bindRequiredNames(node.name, moduleName, bindings);
      }
      bindings.declared.add(node.name.text);
    }

    const requiredModule = readRequiredModule(node);
    if (requiredModule === 'unresolvable') {
      bindings.unresolvableModule = true;
    } else if (requiredModule) {
      bindings.imports.add(requiredModule);
      const bindingName = findEnclosingBinding(node);
      if (bindingName) bindRequiredNames(bindingName, requiredModule, bindings);
    }

    if (ts.isVariableDeclaration(node) || ts.isParameter(node)) {
      declareBindingName(node.name, bindings);
    }
    if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name) {
      bindings.declared.add(node.name.text);
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return bindings;
}

function describeSpawnCall(node, bindings) {
  const callee = node.expression;
  if (ts.isIdentifier(callee)) {
    if (bindings.apis.has(callee.text)) return `calls ${callee.text}()`;
    return SPAWN_APIS.has(callee.text) && !bindings.declared.has(callee.text)
      ? `calls ${callee.text}()`
      : null;
  }

  if (!ts.isPropertyAccessExpression(callee) || !ts.isIdentifier(callee.expression)) {
    return null;
  }
  const namespace = callee.expression.text;
  return bindings.namespaces.has(namespace) && SPAWN_APIS.has(callee.name.text)
    ? `calls ${namespace}.${callee.name.text}()`
    : null;
}

/**
 * Reports how a source starts a process, if it does.
 *
 * The decision is made on the syntax tree rather than on the shape of a call, because a
 * call named `exec` says nothing on its own: `pattern.exec(line)` matches a regular
 * expression and `store.exec(statement)` runs SQL. A call counts only when what it calls
 * resolves to a process-module binding, and pulling that module in counts on its own. A
 * bare call to a spawn name the source never declared is still reported, so nothing slips
 * past through a global.
 */
export function findProcessSpawnUsages(sourceText, fileName = 'source.ts') {
  const sourceFile = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const bindings = collectBindings(sourceFile);
  const usages = [...bindings.imports].map(moduleName => ({
    fileName,
    reason: `imports '${moduleName}'`,
  }));
  if (bindings.unresolvableModule) {
    usages.push({ fileName, reason: 'requires a module specifier that cannot be read' });
  }

  const visit = (node) => {
    const reason = ts.isCallExpression(node) ? describeSpawnCall(node, bindings) : null;
    if (reason) usages.push({ fileName, reason });
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  return usages;
}

/** Every process-spawning usage across the given TypeScript sources. */
export function findProcessSpawnFiles(files, readFile) {
  const violations = [];
  for (const file of files) {
    const reasons = findProcessSpawnUsages(readFile(file), file).map(usage => usage.reason);
    if (reasons.length > 0) violations.push({ file, reasons });
  }
  return violations;
}
