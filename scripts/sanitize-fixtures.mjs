#!/usr/bin/env node
// fixtures/raw/  ->  fixtures/clean/
//
//   npm run sanitize              write fixtures/clean/
//   npm run sanitize -- --check   report problems, write nothing
//
// Optional: fixtures/raw/redact.txt (one term per line) lists extra strings
// that must never appear in output, such as your name, username, or school.
// It lives in the private folder, so it is never committed either.
//
// "Web Page, complete" saves a <name>_files/ folder next to each page with the
// site's scripts, styles and images. Those are skipped, not copied.

import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, relative, extname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Sanitizer } from './lib/sanitize.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RAW = join(ROOT, 'fixtures', 'raw');
const CLEAN = join(ROOT, 'fixtures', 'clean');
const NOTES = join(ROOT, 'fixtures', 'README.md');
const check = process.argv.includes('--check');

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (/_files$/.test(name)) continue;
      out.push(...walk(full));
    } else {
      out.push(full);
    }
  }
  return out;
}

function main() {
  if (!existsSync(RAW)) {
    console.error('fixtures/raw/ does not exist. Save pages there first (see README → Fixtures).');
    process.exit(1);
  }
  const redactFile = join(RAW, 'redact.txt');
  const redactTerms = existsSync(redactFile)
    ? readFileSync(redactFile, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
    : [];
  const s = new Sanitizer({ redactTerms });

  let problems = 0;
  let written = 0;
  const report = (file, findings) => {
    if (!findings.length) return;
    problems += findings.length;
    console.error(`\n✗ ${file}`);
    for (const f of findings) console.error(`    ${f.line ? `line ${f.line}: ` : ''}${f.problem}  [${f.excerpt}]`);
  };
  const emit = (target, result, label) => {
    report(label, result.findings);
    if (check || result.findings.length) return;
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, result.text);
    written += 1;
  };

  for (const file of walk(RAW)) {
    const rel = relative(RAW, file);
    if (rel === 'redact.txt') continue;
    const ext = extname(file).toLowerCase();
    const cleanName = basename(rel).replace(/\d{5,}|[0-9a-f]{16,}/gi, (m) => s.fakeId(m));
    const target = join(CLEAN, dirname(rel), cleanName);
    const text = readFileSync(file, 'utf8');
    if (ext === '.html' || ext === '.htm' || ext === '.xhtml') emit(target, s.sanitizeHtml(text), rel);
    else if (ext === '.json') emit(target, s.sanitizeJsonFile(text), rel);
    else if (ext === '.har') console.error(`- skipped ${rel}: HAR files carry cookies; save the page instead`);
    else console.error(`- skipped ${rel}: unsupported type`);
  }
  if (existsSync(NOTES)) emit(join(CLEAN, 'README.md'), s.sanitizeNotes(readFileSync(NOTES, 'utf8')), 'fixtures/README.md');

  if (problems) {
    console.error(`\n${problems} problem(s). Files with problems were not written. Fix the sanitizer or add terms to fixtures/raw/redact.txt.`);
    process.exit(1);
  }
  console.log(check ? 'sanitize --check: clean' : `sanitize: wrote ${written} file(s) to fixtures/clean/`);
}

main();
