#!/usr/bin/env node
// Fails if tracked content looks like a secret, a personal Google URL, or a
// file from the private folders. Zero dependencies so CI can run it bare.
//
//   node scripts/scan-secrets.mjs            scan every tracked file (default)
//   node scripts/scan-secrets.mjs --staged   scan what is about to be committed (pre-commit hook)
//   node scripts/scan-secrets.mjs --history  scan every line ever added, in every commit (CI)
//
// A line containing "scan-secrets:allow" is skipped. Use it sparingly and only
// for obviously fake test values.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const FORBIDDEN_PATHS = [
  { name: 'private folder reference/', re: /^reference\// },
  { name: 'private folder fixtures/raw/', re: /^fixtures\/raw\// },
  { name: 'fixtures/README.md (lists your account URLs)', re: /^fixtures\/README\.md$/ },
  { name: 'clasp project file', re: /(^|\/)\.clasp(rc)?\.json$/ },
  { name: 'env file', re: /(^|\/)\.env(\..*)?$/ },
  { name: 'packed extension', re: /\.xpi$/ },
];

const ID = '[A-Za-z0-9_-]';

export const RULES = [
  { name: 'Apps Script web app URL', re: new RegExp(`script\\.google\\.com/(a/[^/\\s]+/)?macros/s/${ID}{20,}`) },
  { name: 'Apps Script redirect URL', re: /script\.googleusercontent\.com\/macros\/echo\?/ },
  { name: 'Apps Script deployment ID', re: new RegExp(`AKfyc${ID}{30,}`) },
  { name: 'Apps Script project URL', re: new RegExp(`script\\.google\\.com/(home/)?(projects|d)/${ID}{20,}`) },
  { name: 'Apps Script script ID', re: new RegExp(`["']?scriptId["']?\\s*[:=]\\s*["']${ID}{30,}`) },
  { name: 'Google Docs/Sheets URL', re: new RegExp(`docs\\.google\\.com/(spreadsheets|document|forms|presentation)/(u/\\d+/)?d/${ID}{20,}`) },
  { name: 'Google Drive URL', re: new RegExp(`drive\\.google\\.com/(drive/(u/\\d+/)?folders|file/d|open\\?id=)/?${ID}{20,}`) },
  { name: 'openById with a literal ID', re: new RegExp(`openById\\(\\s*["']${ID}{20,}`) },
  { name: 'Google API key', re: /AIza[0-9A-Za-z_-]{35}/ },
  { name: 'Google OAuth access token', re: /ya29\.[0-9A-Za-z_-]{20,}/ },
  { name: 'Google OAuth refresh token', re: /1\/\/0[0-9A-Za-z_-]{30,}/ },
  { name: 'Google OAuth client secret', re: /GOCSPX-[0-9A-Za-z_-]{20,}/ },
  { name: 'GitHub token', re: /\b(gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})\b/ },
  { name: 'AMO API key', re: /\buser:\d{4,}:\d{1,4}\b/ },
  { name: 'AWS access key', re: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: 'Slack token', re: /\bxox[abprs]-[0-9A-Za-z-]{10,}/ },
  { name: 'private key block', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: 'JSON Web Token', re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  { name: 'bearer token', re: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/ },
  {
    name: 'hard-coded secret',
    re: /\b(secret|token|password|passwd|api[_-]?key|auth[_-]?key|session[_-]?id|csrf[_-]?token)\b["']?\s*[:=]\s*["'][^"'\s]{12,}["']/i,
    allow: /example|placeholder|dummy|fake|changeme|redacted|xxxx|<[^>]+>|\$\{|test[-_]?secret|not[-_]a[-_]real/i,
  },
  {
    name: 'email address',
    re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g,
    allowMatch: /@(example\.(com|org|net)|[a-z0-9.-]+\.(invalid|test|example)|users\.noreply\.github\.com)$|^noreply@anthropic\.com$|^git@github\.com$/i,
  },
];

const ALLOW_MARKER = 'scan-secrets:allow';

export function scanText(text, file) {
  const findings = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    if (line.includes(ALLOW_MARKER)) return;
    for (const rule of RULES) {
      if (rule.allowMatch) {
        const re = new RegExp(rule.re.source, rule.re.flags.includes('g') ? rule.re.flags : rule.re.flags + 'g');
        for (const m of line.matchAll(re)) {
          if (!rule.allowMatch.test(m[0])) findings.push({ file, line: i + 1, rule: rule.name, excerpt: m[0] });
        }
        continue;
      }
      const m = line.match(rule.re);
      if (m && !(rule.allow && rule.allow.test(m[0]))) {
        findings.push({ file, line: i + 1, rule: rule.name, excerpt: m[0] });
      }
    }
  });
  return findings;
}

export function scanPath(file) {
  return FORBIDDEN_PATHS.filter((p) => p.re.test(file)).map((p) => ({ file, line: 0, rule: p.name, excerpt: file }));
}

function git(args, opts = {}) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...opts });
}

function isBinary(buf) {
  return buf.subarray(0, 8000).includes(0);
}

function scanFiles(paths, read) {
  const findings = [];
  for (const file of paths) {
    findings.push(...scanPath(file));
    let buf;
    try {
      buf = read(file);
    } catch {
      continue; // deleted or unreadable
    }
    if (isBinary(buf)) continue;
    findings.push(...scanText(buf.toString('utf8'), file));
  }
  return findings;
}

function scanTracked() {
  const files = git(['ls-files', '-z']).split('\0').filter(Boolean);
  return scanFiles(files, (f) => readFileSync(f));
}

function scanStaged() {
  const files = git(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z']).split('\0').filter(Boolean);
  return scanFiles(files, (f) => execFileSync('git', ['show', `:${f}`]));
}

// Every added line in every commit reachable from HEAD, plus every path ever added.
function scanHistory() {
  const findings = [];
  let log;
  try {
    log = git(['log', '-p', '--no-color', '--no-ext-diff', '--format=@@commit %H', 'HEAD']);
  } catch {
    return findings; // no commits yet
  }
  let commit = '';
  let file = '';
  let lineNo = 0;
  for (const line of log.split('\n')) {
    if (line.startsWith('@@commit ')) {
      commit = line.slice(9, 16);
    } else if (line.startsWith('+++ ')) {
      file = line.startsWith('+++ b/') ? line.slice(6) : '';
      if (file) findings.push(...scanPath(file).map((f) => ({ ...f, file: `${file} (commit ${commit})` })));
    } else if (line.startsWith('@@ ')) {
      const m = line.match(/\+(\d+)/);
      lineNo = m ? Number(m[1]) - 1 : 0;
    } else if (line.startsWith('+') && file) {
      lineNo += 1;
      for (const f of scanText(line.slice(1), file)) {
        findings.push({ ...f, file: `${file} (commit ${commit})`, line: lineNo });
      }
    } else if (!line.startsWith('-')) {
      lineNo += 1;
    }
  }
  return findings;
}

function main() {
  const mode = process.argv.includes('--staged') ? 'staged' : process.argv.includes('--history') ? 'history' : 'tracked';
  const findings = mode === 'staged' ? scanStaged() : mode === 'history' ? scanHistory() : scanTracked();
  if (findings.length === 0) {
    console.log(`scan-secrets (${mode}): clean`);
    return;
  }
  console.error(`scan-secrets (${mode}): ${findings.length} problem(s) found\n`);
  for (const f of findings) {
    const where = f.line ? `${f.file}:${f.line}` : f.file;
    const shown = f.excerpt.length > 24 ? `${f.excerpt.slice(0, 12)}…${f.excerpt.slice(-4)}` : f.excerpt;
    console.error(`  ${where}  ${f.rule}  [${shown}]`);
  }
  console.error(
    '\nRemove the value (secrets belong in browser.storage.local or Script Properties), ' +
      'or unstage the file. If it was already pushed, rotate the secret first.',
  );
  process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
