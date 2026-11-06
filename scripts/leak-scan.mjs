#!/usr/bin/env node
// Leak scan for a public repository and npm package. Fails (exit 1) if any scanned file holds a
// credential, a private address, a non-public AIVeed hostname, a personal path or an email address
// other than the public support one.
//
//   node scripts/leak-scan.mjs            every tracked and untracked (not ignored) file, and their names
//   node scripts/leak-scan.mjs --pack     exactly what `npm pack` would publish (run after build)
//   node scripts/leak-scan.mjs --staged   the staged versions of files about to be committed
//   node scripts/leak-scan.mjs --files a b  the named files (e.g. a commit message)
//   node scripts/leak-scan.mjs --history  every commit: author and committer identity, message and
//                                         every line it added (needs the full history checked out)
//
// LEAK_SCAN_DENYLIST=<file> adds patterns kept outside the repository (one case-insensitive
// regular expression per line, # comments), for names that must not appear here but must not be
// listed here either.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const PUBLIC_HOSTS = new Set(['aiveed.io', 'www.aiveed.io', 'api.aiveed.io', 'developer.aiveed.io']);
const PUBLIC_EMAILS = new Set(['support@aiveed.io']);
const PUBLIC_IDENTITY = 'AIVeed <support@aiveed.io>'; // the only commit author/committer allowed
const LOCAL_PORTS = new Set(['8080', '8787']); // the examples used in docs and tests
// IPv4 addresses that may appear: loopback, "any", and the documentation ranges (RFC 5737).
const PUBLIC_IPV4 = /^(127\.0\.0\.1|0\.0\.0\.0|192\.0\.2\.\d+|198\.51\.100\.\d+|203\.0\.113\.\d+)$/;

const RULES = [
  ['AIVeed API key', /aiv_sk_[0-9a-f]{64}/gi],
  ['private key block', /-----BEGIN [A-Z ]*PRIVATE KEY-----/g],
  ['AWS access key', /\b(AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ['GitHub token', /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}/g],
  ['npm token', /\bnpm_[A-Za-z0-9]{36}\b/g],
  ['API secret key', /\b(sk|rk)[-_](live|test|proj)[-_][A-Za-z0-9]{16,}/g],
  ['Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/g],
  ['JWT', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g],
  ['OpenAI/Anthropic-style key', /\bsk-(ant-|proj-)?[A-Za-z0-9_-]{20,}/g],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ['vendor API key', /\b(re|rk|pk|whsec|xai|gsk|hf)_[A-Za-z0-9]{16,}/g],
  ['AWS secret key', /aws.{0,20}(secret|key).{0,5}[:=]\s*['"]?[A-Za-z0-9/+=]{40}\b/gi],
  // `password: "..."`, `{"api_key":"..."}`, `TOKEN=...`: a credential-like name, then a value of
  // 12+ characters with both letters and digits (placeholders like ${VAR} or "aiv_sk_..." do not match).
  ['credential assignment', /\b[\w-]*(pass(word|wd)?|secret|token|api[_-]?key|private[_-]?key|access[_-]?key|client[_-]?secret)\b["']?\s*[:=]\s*["']?(?=[^"'\s,;}]*\d)(?=[^"'\s,;}]*[A-Za-z])[^"'\s,;}$.]{12,}/gi],
  ['credentials in a URL', /[a-z][a-z0-9+.-]*:\/\/[^\s/:@'"`]+:[^\s/@'"`]+@/gi],
  ['IPv6 private or link-local address', /\b(f[cd][0-9a-f]{2}|fe80):[0-9a-f:]{2,}\b/gi],
  ['cloud internal hostname', /\b(ip-\d{1,3}-\d{1,3}-\d{1,3}-\d{1,3}|[a-z0-9-]+\.(internal|local|lan|corp|intranet))\b/gi],
  ['personal or server path', /(\/home\/[a-z_][\w.-]*|\/r(?:o)ot\b|\/Users\/[\w.-]+|\/var\/www\b|\/srv\/|\/opt\/[\w.-]+|[A-Za-z]:\\{1,2}Users\\{1,2}[\w.-]+)/gi],
  ['bare port setting', /\b(PORT|port)\s*[=:]\s*['"]?\d{4,5}\b|0\.0\.0\.0:\d{2,5}/g],
  ['AIVeed lookalike domain', /\b[a-z0-9-]*aiveed\.(?!io\b)[a-z]{2,}\b|\b[a-z0-9]+-aiveed\.io\b|\baiveed\.io\.[a-z]/gi],
  ['invisible character', /[\u200b-\u200f\u2060\ufeff]/g],
];

function denylist() {
  const file = process.env.LEAK_SCAN_DENYLIST;
  if (!file) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => ['private denylist entry', new RegExp(l, 'gi')]);
}

function findings(text) {
  const out = [];
  for (const [name, re] of [...RULES, ...denylist()]) for (const m of text.matchAll(re)) out.push([name, m[0], m.index]);
  for (const m of text.matchAll(/\b([a-z0-9-]+\.)*aiveed\.io\b/gi)) {
    if (!PUBLIC_HOSTS.has(m[0].toLowerCase())) out.push(['non-public AIVeed hostname', m[0], m.index]);
  }
  for (const m of text.matchAll(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g)) {
    const email = m[0].toLowerCase();
    // example.com/.org/.net are reserved for documentation (RFC 2606).
    if (!PUBLIC_EMAILS.has(email) && !/@example\.(com|org|net)$/.test(email)) out.push(['email address', m[0], m.index]);
  }
  for (const m of text.matchAll(/(?:\blocalhost|\b127\.0\.0\.1|\[::1\]):(\d{2,5})\b/g)) {
    if (!LOCAL_PORTS.has(m[1])) out.push(['local port', m[0], m.index]);
  }
  for (const m of text.matchAll(/\b(?<![\d.])(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?![\d.])\b/g)) {
    if (m.slice(1).every((x) => Number(x) <= 255) && !PUBLIC_IPV4.test(m[0])) out.push(['IPv4 address', m[0], m.index]);
  }
  return out;
}

/** package-lock.json: only registry.npmjs.org, plus every normal rule (integrity hashes excluded). */
function lockfileFindings(text) {
  const out = [];
  for (const m of text.matchAll(/"resolved":\s*"([^"]+)"/g)) {
    if (!m[1].startsWith('https://registry.npmjs.org/')) out.push(['non-npm registry URL', m[1], m.index]);
  }
  // Base64 integrity hashes can contain anything; blank them (keeping offsets) before the rules.
  const scrubbed = text.replace(/"integrity":\s*"[^"]+"/g, (m) => ' '.repeat(m.length));
  return out.concat(findings(scrubbed));
}

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const mode = process.argv[2] || '--tracked';
let files;
let read = (f) => readFileSync(f, 'utf8');
if (mode === '--pack') {
  const [pack] = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { encoding: 'utf8' }));
  files = pack.files.map((f) => f.path);
} else if (mode === '--files') {
  files = process.argv.slice(3);
} else if (mode === '--staged') {
  files = git('diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z').split('\0').filter(Boolean);
  read = (f) => git('show', `:${f}`);
} else {
  files = git('ls-files', '-z').split('\0').filter(Boolean);
}

let bad = 0;
const report = (where, text, list) => {
  for (const [name, match, index] of list) {
    const line = text.slice(0, index).split('\n').length;
    console.error(`${where}:${line}: ${name}: ${match.slice(0, 12)}${match.length > 12 ? '...' : ''}`);
    bad++;
  }
};

if (mode === '--history') {
  // Identities first: a personal name or email in an author line is published with the commit.
  const ids = git('log', '--all', '--format=%H%x09%an <%ae>%x09%cn <%ce>').trim().split('\n').filter(Boolean);
  for (const row of ids) {
    const [sha, author, committer] = row.split('\t');
    for (const who of [author, committer]) {
      if (who !== PUBLIC_IDENTITY) {
        console.error(`commit ${sha.slice(0, 10)}: identity is not ${PUBLIC_IDENTITY}`);
        bad++;
      }
    }
    const message = git('log', '-1', '--format=%B', sha);
    report(`commit ${sha.slice(0, 10)} message`, message, findings(message));
  }
  // Every object reachable from any ref: each path name that ever existed (also deleted or renamed
  // files) and each blob's full content (text or binary, read as latin1), including merges.
  const seen = new Set();
  for (const line of git('rev-list', '--all', '--objects').split('\n')) {
    const [sha, ...rest] = line.split(' ');
    const name = rest.join(' ');
    if (!sha) continue;
    if (name) report(`path ${name}`, name, findings(name));
    if (seen.has(sha) || git('cat-file', '-t', sha).trim() !== 'blob') continue;
    seen.add(sha);
    const blob = execFileSync('git', ['cat-file', 'blob', sha], { maxBuffer: 256 * 1024 * 1024 }).toString('latin1');
    report(`blob ${sha.slice(0, 10)} (${name || 'unnamed'})`, blob, name.endsWith('package-lock.json') ? lockfileFindings(blob) : findings(blob));
  }
  for (const ref of git('for-each-ref', '--format=%(refname:short)').trim().split('\n').filter(Boolean)) {
    report(`ref ${ref}`, ref, findings(ref));
  }
  files = [];
} else if (mode === '--tracked') {
  files.push(...git('ls-files', '-z', '--others', '--exclude-standard').split('\0').filter(Boolean));
}
if (mode === '--files' && files.length === 0) {
  console.error('leak-scan: --files needs at least one file');
  process.exit(2);
}

for (const file of files) {
  report(`${file} (name)`, file, findings(file));
  const text = read(file);
  report(file, text, file.endsWith('package-lock.json') ? lockfileFindings(text) : findings(text));
}
if (bad) {
  console.error(`leak-scan: ${bad} finding(s) in ${files.length} file(s). Remove them before committing or publishing.`);
  process.exit(1);
}
console.log(`leak-scan: clean (${mode === '--history' ? 'all commits' : `${files.length} files`}, ${mode.replace('--', '')})`);
