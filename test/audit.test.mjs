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

test('skip_specs:true dispensa teste sem gerar AC_SEM_TESTE', () => {
  const root = setupTree({
    'openspec/specs/auth/spec.md': `### Requirement: Login\nThe system MUST log in.\n#### Scenario: Entra\n- WHEN entra\n- THEN ok\n`,
    'openspec/changes/tooling/.openspec.yaml': `skip_specs: true\n`,
    'openspec/changes/tooling/specs/auth/spec.md': `## ADDED Requirements\n\n### Requirement: Lint Interno\nFerramenta interna sem comportamento.\n\n#### Scenario: Roda\n- WHEN roda\n- THEN ok\n`,
    'tests/auth.test.ts': `// @spec:login\ntest('login', () => {});`,
  });
  const r = runAudit(root, ['--json']);
  assert.equal(r.code, 0, r.stdout);
  const data = JSON.parse(r.stdout);
  assert.equal(data.summary.skipped, 1);
  assert.equal(data.summary.requirements, 1);
});

test('tag @spec: em teste pulado não conta como prova (exit( não é skip)', () => {
  const root = setupTree({
    'openspec/specs/auth/spec.md': `### Requirement: Login\nThe system MUST log in.\n\n#### Scenario: Entra\n- WHEN entra\n- THEN ok\n`,
    'tests/auth.test.ts': `// @spec:login\ntest.skip('login pulado', () => {});\ncheckHealth(base).catch(() => { console.error('x'); process.exit(1); });`,
  });
  const r = runAudit(root);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /AC_SEM_TESTE/);
  assert.match(r.stdout, /TESTE_PULADO/);
});

test('duplicata case-insensitive vira erro; par 1-delta+1-main é legítimo', () => {
  const dup = setupTree({
    'openspec/changes/a/specs/auth/spec.md': `## ADDED Requirements\n\n### Requirement: Late Fees\nCobra multa.\n\n#### Scenario: Cobra\n- WHEN atrasa\n- THEN cobra\n`,
    'openspec/changes/b/specs/auth/spec.md': `## ADDED Requirements\n\n### Requirement: late fees\nCobra multa.\n\n#### Scenario: Cobra\n- WHEN atrasa\n- THEN cobra\n`,
    'tests/auth.test.ts': `// @spec:late-fees\ntest('x', () => {});`,
  });
  const r1 = runAudit(dup);
  assert.equal(r1.code, 1);
  assert.match(r1.stdout, /ID_DUPLICADO/);

  const legit = setupTree({
    'openspec/specs/auth/spec.md': `### Requirement: Login\nEntra.\n\n#### Scenario: Entra\n- WHEN entra\n- THEN ok\n`,
    'openspec/changes/login/specs/auth/spec.md': `## MODIFIED Requirements\n\n### Requirement: Login\nEntra com 2FA.\n\n#### Scenario: Entra\n- WHEN entra\n- THEN ok\n`,
    'tests/auth.test.ts': `// @spec:login\ntest('login', () => {});`,
  });
  const r2 = runAudit(legit);
  assert.equal(r2.code, 0, r2.stdout);
});

test('RENAMED sem par vira erro; fechamento ### e bullet são tolerados', () => {
  const bad = setupTree({
    'openspec/specs/auth/spec.md': `### Requirement: Login\nEntra.\n\n#### Scenario: E\n- WHEN e\n- THEN o\n`,
    'openspec/changes/rn/specs/auth/spec.md': `## RENAMED Requirements\n\nFROM: Old Name\n`,
    'tests/auth.test.ts': `// @spec:login\ntest('login', () => {});`,
  });
  const r1 = runAudit(bad);
  assert.equal(r1.code, 1);
  assert.match(r1.stdout, /RENAMED_INVALIDO/);

  const ok = setupTree({
    'openspec/specs/auth/spec.md': `### Requirement: Login\nEntra.\n\n#### Scenario: E\n- WHEN e\n- THEN o\n`,
    'openspec/changes/rn/specs/auth/spec.md': `## REMOVED Requirements\n\n- ### Requirement: Password Auth ###\n(removido)\n`,
    'tests/auth.test.ts': `// @spec:login\ntest('login', () => {});`,
  });
  const r2 = runAudit(ok);
  assert.equal(r2.code, 0, r2.stdout);
  assert.doesNotMatch(r2.stdout, /password-auth.*AC_SEM_TESTE/s);
});

test('requirement fora de seção vira aviso e não exige teste; delta fora de spec.md vira erro', () => {
  const warn = setupTree({
    'openspec/specs/auth/spec.md': `### Requirement: Login\nEntra.\n\n#### Scenario: E\n- WHEN e\n- THEN o\n`,
    'openspec/changes/n/specs/auth/spec.md': `## Notes\n\n### Requirement: Ideia Solta\nSó anotação.\n`,
    'tests/auth.test.ts': `// @spec:login\ntest('login', () => {});`,
  });
  const r1 = runAudit(warn);
  assert.equal(r1.code, 0, r1.stdout);
  assert.match(r1.stdout, /DELTA_FORA_DE_SECAO/);

  const badPath = setupTree({
    'openspec/specs/auth/spec.md': `### Requirement: Login\nEntra.\n\n#### Scenario: E\n- WHEN e\n- THEN o\n`,
    'openspec/changes/n/specs/notas.md': `## ADDED Requirements\n\n### Requirement: Extra\nCoisa.\n\n#### Scenario: E\n- WHEN e\n- THEN o\n`,
    'tests/auth.test.ts': `// @spec:login\n// @spec:extra\ntest('login', () => {});`,
  });
  const r2 = runAudit(badPath);
  assert.equal(r2.code, 1);
  assert.match(r2.stdout, /DELTA_PATH_INVALIDO/);
});

test('pattern com risco de ReDoS gera aviso PATTERN_ARRISCADO sem falhar', () => {
  const root = setupTree({
    'openspec/specs/auth/spec.md': `### Requirement: Login\nEntra.\n\n#### Scenario: E\n- WHEN e\n- THEN o\n`,
    'tests/auth.test.ts': `// @spec:login\ntest('login', () => {});`,
    'src/a.ts': `const x = 1;`,
    'spec-audit.config.json': JSON.stringify({
      principles: [{ id: 'P-RISCO', type: 'no_regex', glob: 'src/**/*.ts', pattern: '(a+)+$' }],
    }),
  });
  const r = runAudit(root);
  assert.equal(r.code, 0, r.stdout);
  assert.match(r.stdout, /PATTERN_ARRISCADO/);
});
