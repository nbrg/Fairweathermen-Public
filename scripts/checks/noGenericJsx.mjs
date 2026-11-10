#!/usr/bin/env node
// Fails if any .tsx file uses an explicit type argument on a JSX tag, e.g.
//   <SelectField<Rule> value={...} />
// tsc and `npm run build` accept that, but the esbuild that Vite's dev server
// uses in some hosted dev environments doesn't, so the dev preview breaks while every check passes.
// Let TypeScript infer the type from the props instead (or type a prop, e.g.
// `onChange={(v: Rule) => ...}`).
//
// Run by `npm run check` (and so by CI). Uses the TypeScript parser, so a type
// like `Array<Promise<T>>` in ordinary code is never flagged.
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import ts from "typescript";

const files = execSync("git ls-files --cached --others --exclude-standard -- '*.tsx'", { encoding: "utf8" })
  .split("\n")
  .filter(Boolean);

const problems = [];
for (const file of files) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue; // deleted in the working tree but still in the index
  }
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const visit = (node) => {
    if (
      (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
      node.typeArguments?.length
    ) {
      const { line, character } = source.getLineAndCharacterOfPosition(node.getStart(source));
      const tag = node.tagName.getText(source);
      problems.push(`${file}:${line + 1}:${character + 1}  <${tag}<...>>`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}

if (problems.length) {
  console.error("Explicit type arguments on JSX tags break the Vite dev server (esbuild) in some environments:");
  for (const p of problems) console.error(`  ${p}`);
  console.error("Drop the <...> after the tag name and let TypeScript infer it from the props.");
  process.exit(1);
}
