#!/usr/bin/env node
// spec-anchored — auditoria mecânica de specs OpenSpec contra código e testes.
// Spec-first deixa a spec virar mentira; spec-anchored verifica, mecanicamente,
// que todo critério de aceite tem teste anotado e que princípios valem no código.
// Zero dependências. Node >= 18.
//
// Uso:
//   node audit-specs.mjs [--root <dir>] [--config <arquivo>]
//                        [--test-command "<cmd>"] [--json] [--strict]
//
// Exit codes: 0 = ok, 1 = erros encontrados, 2 = uso/config inválido.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = resolve(process.argv.includes('--root')
  ? process.argv[process.argv.indexOf('--root') + 1]
  : '.');
const FLAG_JSON = process.argv.includes('--json');
const FLAG_STRICT = process.argv.includes('--strict');

const TEST_COMMAND = process.argv.includes('--test-command')
  ? process.argv[process.argv.indexOf('--test-command') + 1]
  : null;
const CONFIG_PATH = process.argv.includes('--config')
  ? resolve(process.argv[process.argv.indexOf('--config') + 1])
  : join(ROOT, 'spec-audit.config.json');

// ───────────────────────────── config ─────────────────────────────

const DEFAULT_CONFIG = {
  ignore: ['node_modules', '.git', 'dist', 'build', 'coverage', '.opencode', '.claude', '.agents', 'archive'],
  specs: { dir: 'openspec/specs', changesDir: 'openspec/changes' },
  tests: { include: ['**/*.{test,spec}.{js,ts,mjs,jsx,tsx}'], exclude: ['node_modules/**', '**/dist/**', '**/build/**', '**/coverage/**'] },
  principles: [],
};

let config = DEFAULT_CONFIG;
if (existsSync(CONFIG_PATH)) {
  try {
    config = { ...DEFAULT_CONFIG, ...JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) };
    config.tests = { ...DEFAULT_CONFIG.tests, ...(config.tests || {}) };
  } catch (e) {
    die(`config inválido em ${CONFIG_PATH}: ${e.message}`, 2);
  }
}

// ───────────────────────────── helpers ─────────────────────────────

function die(msg, code) { console.error(`ERRO de uso: ${msg}`); process.exit(code); }

function escapeRE(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function globToRegex(glob) {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') { out += '(?:[^/]+/)*'; i += 2; }
        else { out += '.*'; i += 1; }
      } else out += '[^/]*';
    } else if (c === '?') out += '[^/]';
    else if (c === '{') {
      const end = glob.indexOf('}', i);
      const parts = glob.slice(i + 1, end).split(',');
      out += '(?:' + parts.map(p => globToRegex(p).source.replace(/^\^|\$$/g, '')).join('|') + ')';
      i = end;
    } else out += escapeRE(c);
  }
  return new RegExp('^' + out + '$');
}

function walk(dir, rel = '') {
  const out = [];
  let entries;
  try { entries = readdirSync(dir); } catch { return out; }
  for (const e of entries) {
    const full = join(dir, e);
    const relPath = rel ? `${rel}/${e}` : e;
    if (config.ignore.includes(e) || config.ignore.includes(relPath)) continue;
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) out.push(...walk(full, relPath));
    else if (st.isFile()) out.push(relPath);
  }
  return out;
}

function matchFiles(globs, files) {
  const re = globs.map(globToRegex);
  return files.filter(f => re.some(r => r.test(f)));
}

function fileLineAt(content, index) {
  return content.slice(0, index).split('\n').length;
}

// ───────────────────────────── specs ─────────────────────────────

// Extrai requirements de um spec.md (formato OpenSpec).
// Requirement: <Título [AC-001]> → { id, title, line, file, delta }
// Delta pode ser ADDED | MODIFIED | REMOVED (só em changes/).
function parseSpecFile(file, fullPath) {
  const content = readFileSync(fullPath, 'utf8');
  const out = [];
  const reqRe = /^#{3,5}\s+Requirement:\s+(.+?)\s*$/gm;
  const sections = [...content.matchAll(/^##\s+(ADDED|MODIFIED|REMOVED)\s+Requirements?$/gm)];
  for (const m of content.matchAll(reqRe)) {
    const title = m[1].trim();
    let delta = null;
    for (const s of sections) if (s.index < m.index) delta = s[1];
    const idMatch = title.match(/\[(AC-[A-Z0-9]+|[a-z0-9-]+)\]/);
    const id = idMatch ? idMatch[1] : slug(title);
    out.push({
      id, title: title.replace(/\s*\[.*?\]\s*$/, '').trim(),
      line: fileLineAt(content, m.index),
      file: file,
      delta,
      active: delta !== 'REMOVED',
    });
  }
  return out;
}

function slug(s) {
  return s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'unnamed';
}

function loadSpecs() {
  const specsDir = join(ROOT, config.specs.dir);
  const changesDir = join(ROOT, config.specs.changesDir);
  const requirements = [];

  for (const f of walk(specsDir).filter(f => f.endsWith('.md'))) {
    requirements.push(...parseSpecFile(f, join(specsDir, f)));
  }
  for (const f of walk(changesDir).filter(f => f.endsWith('.md'))) {
    requirements.push(...parseSpecFile(f, join(changesDir, f)));
  }
  return requirements.filter(r => r.active);
}

// ───────────────────────────── testes ─────────────────────────────

function loadTestAnnotations(files) {
  const found = new Map(); // id -> [{ file, line }]
  for (const f of files) {
    const content = readFileSync(join(ROOT, f), 'utf8');
    const re = /@spec:([A-Za-z0-9_-]+)/g;
    let m;
    while ((m = re.exec(content)) !== null) {
      const id = m[1];
      if (!found.has(id)) found.set(id, []);
      found.get(id).push({ file: f, line: fileLineAt(content, m.index) });
    }
  }
  return found;
}

// ───────────────────────────── princípios ─────────────────────────────

function checkPrinciples(files, findings) {
  for (const p of config.principles || []) {
    if (!p.id || !p.type || !p.glob) {
      findings.push({ code: 'CONFIG_INVALIDA', severity: 'error', message: `princípio sem id/type/glob: ${JSON.stringify(p)}` });
      continue;
    }
    const matched = matchFiles([p.glob], files);
    if (p.type === 'file_exists') {
      if (matched.length === 0) {
        findings.push({ code: 'PRINCIPIO_VIOLADO', severity: 'error', principle: p.id,
          message: p.message || `nenhum arquivo casa o glob \`${p.glob}\`` });
      }
      continue;
    }
    if (matched.length === 0) {
      findings.push({ code: 'GLOB_SEM_ARQUIVOS', severity: 'warning', principle: p.id,
        message: `o glob \`${p.glob}\` do princípio ${p.id} não casa nenhum arquivo — verificação inerte (typo no glob?)` });
      continue;
    }
    if (!p.pattern) {
      findings.push({ code: 'CONFIG_INVALIDA', severity: 'error', message: `princípio ${p.id} (${p.type}) sem pattern` });
      continue;
    }
    const re = new RegExp(p.pattern, 'i');
    const ignored = (p.ignore || []).map(globToRegex);
    for (const f of matched) {
      if (ignored.some(r => r.test(f))) continue;
      const content = readFileSync(join(ROOT, f), 'utf8');
      const m = re.exec(content);
      if (p.type === 'no_regex') {
        if (m) {
          findings.push({ code: 'PRINCIPIO_VIOLADO', severity: 'error', principle: p.id,
            file: f, line: fileLineAt(content, m.index),
            message: p.message || `padrão proibido encontrado em ${f}` });
        }
      } else if (p.type === 'regex_required') {
        if (!m) {
          findings.push({ code: 'PRINCIPIO_VIOLADO', severity: 'error', principle: p.id,
            file: f, message: p.message || `${f} não contém o padrão obrigatório` });
        }
      }
    }
  }
}

// ───────────────────────────── test-command ─────────────────────────────

function runTestCommand() {
  const result = { ok: true, passed: null, failed: null, summary: '' };
  try {
    const stdout = execFileSync(TEST_COMMAND, { cwd: ROOT, shell: true, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const json = stdout.match(/\{[\s\S]*\}/);
    if (json) {
      try {
        const data = JSON.parse(json[0]);
        const results = data.testResults || (data.tests ? [{ assertionResults: data.tests }] : []);
        let passed = 0, failed = 0;
        for (const r of results) {
          for (const a of (r.assertionResults || [])) {
            if (a.status === 'passed' || a.status === 'pass') passed++;
            else if (a.status === 'failed' || a.status === 'fail') failed++;
          }
        }
        if (results.length) { result.passed = passed; result.failed = failed; }
      } catch { /* fallback abaixo */ }
    }
    if (result.passed === null) {
      const tapOk = (stdout.match(/^ok\b/gm) || []).length;
      const tapFail = (stdout.match(/^not ok\b/gm) || []).length;
      if (tapOk + tapFail > 0) { result.passed = tapOk; result.failed = tapFail; }
    }
    result.summary = result.passed === null
      ? `exit 0 (sem parser: use --reporter=json ou TAP)`
      : `${result.passed} passando, ${result.failed} falhando`;
  } catch (e) {
    result.ok = false;
    result.summary = `exit ${e.status ?? '?'}: ${String(e.message).split('\n')[0]}`;
  }
  return result;
}

// ───────────────────────────── auditoria ─────────────────────────────

function main() {
  const allFiles = walk(ROOT);
  const testFiles = matchFiles(config.tests.include, allFiles)
    .filter(f => !(config.tests.exclude || []).some(g => globToRegex(g).test(f)));

  const requirements = loadSpecs();
  const annotations = loadTestAnnotations(testFiles);
  const findings = [];

  // 1. AC sem teste
  for (const r of requirements) {
    if (!annotations.has(r.id)) {
      findings.push({
        code: 'AC_SEM_TESTE', severity: 'error',
        file: `${config.specs.dir}/${r.file}`, line: r.line,
        message: `critério de aceite "${r.title}" (${r.id}) não tem nenhum teste anotado com @spec:${r.id}`,
      });
    }
  }

  // 2. Testes órfãos
  const activeIds = new Set(requirements.map(r => r.id));
  for (const [id, locs] of annotations) {
    if (!activeIds.has(id)) {
      for (const loc of locs) {
        findings.push({
          code: 'TESTE_ORFAO', severity: FLAG_STRICT ? 'error' : 'warning',
          file: loc.file, line: loc.line,
          message: `tag @spec:${id} não corresponde a nenhum critério de aceite ativo (spec removida ou tag desatualizada)`,
        });
      }
    }
  }

  // 3. IDs duplicados
  const seen = new Map();
  for (const r of requirements) {
    if (seen.has(r.id)) {
      findings.push({
        code: 'ID_DUPLICADO', severity: 'error',
        file: r.file, line: r.line,
        message: `ID ${r.id} duplicado (também em ${seen.get(r.id)}) — ambiguidade na rastreabilidade`,
      });
    } else seen.set(r.id, r.file);
  }

  // 4. Princípios
  checkPrinciples(allFiles, findings);

  // 5. Test runner (opcional)
  if (TEST_COMMAND) {
    const tr = runTestCommand();
    if (!tr.ok) {
      findings.push({ code: 'TESTES_FALHANDO', severity: 'error',
        message: `suíte de testes falhou: ${tr.summary}` });
    }
    process.stderr.write(`▶ suíte: ${tr.summary}\n`);
  }

  const errors = findings.filter(f => f.severity === 'error');
  const warnings = findings.filter(f => f.severity === 'warning');

  if (FLAG_JSON) {
    console.log(JSON.stringify({
      ok: errors.length === 0,
      summary: {
        requirements: requirements.length,
        annotated: requirements.filter(r => annotations.has(r.id)).length,
        testFiles: testFiles.length,
        errors: errors.length,
        warnings: warnings.length,
      },
      findings,
    }, null, 2));
  } else {
    for (const f of [...errors, ...warnings]) {
      const loc = f.file ? ` ${f.file}:${f.line ?? 0}` : '';
      const tag = f.code + (f.principle ? ` [${f.principle}]` : '');
      console.log(`${f.severity === 'error' ? 'ERRO' : 'AVISO'} ${tag}${loc} — ${f.message}`);
    }
    console.log(`\nresumo: ${requirements.length} critério(s) de aceite · ${requirements.filter(r => annotations.has(r.id)).length} com teste · ${testFiles.length} arquivo(s) de teste · ${errors.length} erro(s), ${warnings.length} aviso(s)`);
    if (errors.length > 0) console.log('✘ auditoria falhou — corrija os erros antes de declarar pronto.');
    else console.log('✔ auditoria ok.');
  }

  process.exit(errors.length > 0 ? 1 : 0);
}

try { main(); } catch (e) { die(String(e.stack || e), 2); }
