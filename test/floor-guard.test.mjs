import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ENGINE = new URL('../scripts/floor-guard.mjs', import.meta.url).pathname;

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function setupRepo() {
  const root = join(tmpdir(), `floor-guard-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(root, 'tests'), { recursive: true });
  mkdirSync(join(root, 'scripts'), { recursive: true });
  writeFileSync(join(root, 'scripts', 'floor-guard.mjs'), 'placeholder');
  git(root, 'init', '-q');
  git(root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '.');
  git(root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'base');
  git(root, 'branch', '-M', 'main');
  return root;
}

function runGuard(root, base = 'main') {
  try {
    const stdout = execFileSync(process.execPath, [ENGINE, '--base', base], { cwd: root, encoding: 'utf8' });
    return { code: 0, stdout };
  } catch (e) {
    return { code: e.status ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

function teardown(root) {
  rmSync(root, { recursive: true, force: true });
}

test('clean quando o diff não baixa o piso', () => {
  const root = setupRepo();
  try {
    writeFileSync(join(root, 'src.js'), 'export const x = 1;\n');
    const r = runGuard(root);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /floor-guard: clean/);
  } finally { teardown(root); }
});

test('supressão nova é barrada', () => {
  const root = setupRepo();
  try {
    writeFileSync(join(root, 'src.ts'), '// @ts-ignore\nconst x: number = 1;\n');
    const r = runGuard(root);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /silenced-checker/);
  } finally { teardown(root); }
});

test('stub novo é barrado', () => {
  const root = setupRepo();
  try {
    writeFileSync(join(root, 'src.js'), 'throw new Error("Not implemented");\n');
    const r = runGuard(root);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /unfinished-work/);
  } finally { teardown(root); }
});

test('skip novo em teste é barrado', () => {
  const root = setupRepo();
  try {
    writeFileSync(join(root, 'tests', 'a.test.js'), 'test.skip("x", () => {});\n');
    const r = runGuard(root);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /test-made-easier/);
  } finally { teardown(root); }
});

test('exclusão de teste sem aprovação é barrada', () => {
  const root = setupRepo();
  try {
    writeFileSync(join(root, 'tests', 'gone.test.js'), 'test("x", () => {});\n');
    git(root, 'add', '.');
    git(root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'add test');
    execFileSync('rm', [join(root, 'tests', 'gone.test.js')]);
    const r = runGuard(root);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /test-deleted/);
  } finally { teardown(root); }
});

test('asserção removida sem aprovação é barrada', () => {
  const root = setupRepo();
  try {
    const p = join(root, 'tests', 'a.test.js');
    writeFileSync(p, 'expect(x).toBe(1);\nexpect(y).toBe(2);\n');
    git(root, 'add', '.');
    git(root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'add test');
    writeFileSync(p, 'expect(x).toBe(1);\n');
    const r = runGuard(root);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /assertion-removed/);
  } finally { teardown(root); }
});

test('threshold afrouxado em CONSTRAINTS.md é barrado', () => {
  const root = setupRepo();
  try {
    const p = join(root, 'CONSTRAINTS.md');
    writeFileSync(p, '# C\n\n- Coverage floor: at least 80%\n');
    git(root, 'add', '.');
    git(root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'add constraints');
    writeFileSync(p, '# C\n\n- Coverage floor: at least 60%\n');
    const r = runGuard(root);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /threshold-loosened/);
  } finally { teardown(root); }
});

test('regra removida de CONSTRAINTS.md é barrada', () => {
  const root = setupRepo();
  try {
    const p = join(root, 'CONSTRAINTS.md');
    writeFileSync(p, '# C\n\n- No secrets in source\n- No skips\n');
    git(root, 'add', '.');
    git(root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'add constraints');
    writeFileSync(p, '# C\n\n- No secrets in source\n');
    const r = runGuard(root);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /rule-removed/);
  } finally { teardown(root); }
});

test('exceção nova em CONSTRAINTS.md é barrada', () => {
  const root = setupRepo();
  try {
    const p = join(root, 'CONSTRAINTS.md');
    writeFileSync(p, '# C\n\n- No secrets in source\n');
    git(root, 'add', '.');
    git(root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'add constraints');
    writeFileSync(p, '# C\n\n- No secrets in source\n\n| W1 | rule | path | reason | owner | exp |\n');
    const r = runGuard(root);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /new-exception/);
  } finally { teardown(root); }
});

test('sem base o guard falha fechado (exit 2)', () => {
  const root = setupRepo();
  try {
    const r = runGuard(root, 'origin/nonexistent');
    assert.equal(r.code, 2);
  } finally { teardown(root); }
});

const sha = (s) => createHash('sha256').update(s).digest('hex');

function approvalFixture() {
  const root = setupRepo();
  const p = join(root, 'tests', 'a.test.js');
  const before = 'expect(x).toBe(1);\nexpect(y).toBe(2);\n';
  const after = 'expect(x).toBe(1);\n';
  writeFileSync(p, before);
  git(root, 'add', '.');
  git(root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'add test');
  const baseCommit = git(root, 'rev-parse', 'HEAD');
  writeFileSync(p, after);
  return { root, p, before, after, baseCommit };
}

function writeApproval(root, entry, baseCommit) {
  writeFileSync(join(root, 'scripts', 'test-removal-approvals.json'),
    JSON.stringify({ version: 1, baseCommit, files: [entry] }));
}

test('remoção aprovada exata passa', () => {
  const { root, p, before, after, baseCommit } = approvalFixture();
  try {
    writeApproval(root, { path: 'tests/a.test.js', before: sha(before), after: sha(after), reason: 'dup', coverage: 'x keeps it' }, baseCommit);
    const r = runGuard(root);
    assert.equal(r.code, 0, r.stderr);
  } finally { teardown(root); }
});

test('remoção além da aprovada invalida', () => {
  const { root, p, before, after, baseCommit } = approvalFixture();
  try {
    writeApproval(root, { path: 'tests/a.test.js', before: sha(before), after: sha(after), reason: 'dup', coverage: 'x keeps it' }, baseCommit);
    writeFileSync(p, '');
    const r = runGuard(root);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /assertion-removed/);
  } finally { teardown(root); }
});

test('base diferente invalida a aprovação', () => {
  const { root, before, after } = approvalFixture();
  try {
    writeApproval(root, { path: 'tests/a.test.js', before: sha(before), after: sha(after), reason: 'dup', coverage: 'x keeps it' }, 'a'.repeat(40));
    const r = runGuard(root);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /assertion-removed/);
  } finally { teardown(root); }
});

test('manifesto malformado falha fechado', () => {
  const root = setupRepo();
  try {
    writeFileSync(join(root, 'scripts', 'test-removal-approvals.json'), '{');
    const r = runGuard(root);
    assert.equal(r.code, 2);
  } finally { teardown(root); }
});

test('supressão em arquivo aprovado continua barrada', () => {
  const { root, p, before, after, baseCommit } = approvalFixture();
  try {
    const suppressed = after + '// @ts-ignore\n';
    writeFileSync(p, suppressed);
    writeApproval(root, { path: 'tests/a.test.js', before: sha(before), after: sha(suppressed), reason: 'dup', coverage: 'x keeps it' }, baseCommit);
    const r = runGuard(root);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /silenced-checker/);
  } finally { teardown(root); }
});
