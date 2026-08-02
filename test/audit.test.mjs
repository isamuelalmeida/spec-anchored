import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ENGINE = new URL('../scripts/audit-specs.mjs', import.meta.url).pathname;

function setupTree(files) {
  const root = join(tmpdir(), `spec-anchored-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
  }
  return root;
}

function runAudit(root, args = []) {
  try {
    const stdout = execFileSync(process.execPath, [ENGINE, '--root', root, ...args], { encoding: 'utf8' });
    return { code: 0, stdout };
  } catch (e) {
    return { code: e.status ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

const PASS_SPEC = `# Auth

## ADDED Requirements

### Requirement: Two-Factor Authentication
The system MUST require a second factor during login.

#### Scenario: Valid code
- GIVEN a user with 2FA enabled
- WHEN the user submits valid credentials
- THEN the user is authenticated

### Requirement: Session Timeout
The system SHALL expire sessions after 30 minutes of inactivity.
`;

test('passa quando todo critério tem teste anotado e princípios ok', () => {
  const root = setupTree({
    'openspec/specs/auth/spec.md': PASS_SPEC,
    'tests/auth.test.ts': `// @spec:two-factor-authentication\n// @spec:session-timeout\ntest('2fa', () => {});`,
  });
  const r = runAudit(root);
  assert.equal(r.code, 0, r.stdout);
  assert.match(r.stdout, /✔ auditoria ok/);
});

test('AC sem teste vira erro (exit 1)', () => {
  const root = setupTree({
    'openspec/specs/auth/spec.md': PASS_SPEC,
    'tests/auth.test.ts': `// @spec:session-timeout\ntest('timeout', () => {});`,
  });
  const r = runAudit(root);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /AC_SEM_TESTE/);
  assert.match(r.stdout, /two-factor-authentication/);
});

test('teste órfão vira aviso (e erro com --strict)', () => {
  const root = setupTree({
    'openspec/specs/auth/spec.md': PASS_SPEC,
    'tests/auth.test.ts': `// @spec:two-factor-authentication\n// @spec:session-timeout\n// @spec:feature-removida\ntest('2fa', () => {});`,
  });
  const r = runAudit(root);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /TESTE_ORFAO/);
  assert.match(r.stdout, /feature-removida/);
  const strict = runAudit(root, ['--strict']);
  assert.equal(strict.code, 1);
});

test('ID explícito [AC-001] é respeitado nas tags', () => {
  const root = setupTree({
    'openspec/specs/auth/spec.md': `### Requirement: Login [AC-001]\nthe system MUST log in.\n`,
    'tests/auth.test.ts': `// @spec:AC-001\ntest('login', () => {});`,
  });
  const r = runAudit(root);
  assert.equal(r.code, 0, r.stdout);
});

test('change delta ADDED sem teste falha; REMOVED não exige teste', () => {
  const root = setupTree({
    'openspec/specs/auth/spec.md': `### Requirement: Login\nThe system MUST log in.\n`,
    'openspec/changes/drop-password/specs/auth/spec.md': `# Delta for Auth\n\n## ADDED Requirements\n\n### Requirement: Passkey Login\nThe system MUST support passkeys.\n\n## REMOVED Requirements\n\n### Requirement: Password Auth\n(removed)\n`,
    'tests/auth.test.ts': `// @spec:login\ntest('login', () => {});`,
  });
  const r = runAudit(root);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /passkey-login/);
  assert.doesNotMatch(r.stdout, /password-auth/);
});

test('princípio no_regex violado vira erro; file_exists e regex_required ok', () => {
  const root = setupTree({
    'openspec/specs/auth/spec.md': `### Requirement: Login\nThe system MUST log in.\n`,
    'tests/auth.test.ts': `// @spec:login\ntest('login', () => {});`,
    'src/logger.ts': `export function log(evt) { console.log('user', evt.user.email); }`,
    'src/validation.ts': `export function validateInput(s) { /* schema */ }`,
    'spec-audit.config.json': JSON.stringify({
      principles: [
        { id: 'P-LOG-DADOS', type: 'no_regex', glob: 'src/**/*.ts', pattern: 'email', message: 'dados pessoais não podem aparecer em logs' },
        { id: 'P-VALIDA-INPUT', type: 'regex_required', glob: 'src/validation.ts', pattern: 'schema' },
        { id: 'P-SERVICOS', type: 'file_exists', glob: 'src/services/**/*.ts' },
      ],
    }),
  });
  const r = runAudit(root);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /P-LOG-DADOS/);
  assert.match(r.stdout, /src\/logger\.ts:1/);
});

test('glob inerte gera aviso GLOB_SEM_ARQUIVOS', () => {
  const root = setupTree({
    'openspec/specs/auth/spec.md': `### Requirement: Login\nThe system MUST log in.\n`,
    'tests/auth.test.ts': `// @spec:login\ntest('login', () => {});`,
    'spec-audit.config.json': JSON.stringify({
      principles: [{ id: 'P-X', type: 'regex_required', glob: 'nao-existe/**/*.ts', pattern: 'x' }],
    }),
  });
  const r = runAudit(root);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /GLOB_SEM_ARQUIVOS/);
});

test('node_modules e archive são ignorados na varredura', () => {
  const root = setupTree({
    'openspec/specs/auth/spec.md': `### Requirement: Login\nThe system MUST log in.\n`,
    'openspec/changes/archive/old/specs/auth/spec.md': `### Requirement: Login\nThe system MUST log in.\n`,
    'node_modules/pkg/index.test.js': `// @spec:login\ntest('login', () => {});`,
    'tests/auth.test.ts': `// @spec:login\ntest('login', () => {});`,
  });
  const r = runAudit(root);
  assert.equal(r.code, 0, r.stdout);
  assert.doesNotMatch(r.stdout, /node_modules/);
});

test('--json emite relatório máquina com resumo', () => {
  const root = setupTree({
    'openspec/specs/auth/spec.md': PASS_SPEC,
    'tests/auth.test.ts': `// @spec:two-factor-authentication\n// @spec:session-timeout\ntest('ok', () => {});`,
  });
  const r = runAudit(root, ['--json']);
  assert.equal(r.code, 0);
  const data = JSON.parse(r.stdout);
  assert.equal(data.ok, true);
  assert.equal(data.summary.requirements, 2);
  assert.equal(data.summary.annotated, 2);
});

test('test-command falhando vira erro TESTES_FALHANDO', () => {
  const root = setupTree({
    'openspec/specs/auth/spec.md': `### Requirement: Login\nThe system MUST log in.\n`,
    'tests/auth.test.ts': `// @spec:login\ntest('login', () => {});`,
  });
  const r = runAudit(root, ['--test-command', 'node -e "process.exit(1)"']);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /TESTES_FALHANDO/);
});
