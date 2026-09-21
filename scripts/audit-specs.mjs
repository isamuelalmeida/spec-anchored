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
//
// Notas de robustez (portes OpenSpec 1.13.x + onp-spec-driven anti-bypass):
// - Conteúdo normalizado para NFC antes de parse/match (títulos acentuados).
// - Tags @spec: dentro de testes pulados (test.skip/describe.skip/it.skip/
//   xit/xdescribe, com word-boundary para não confundir com `exit(`) NÃO
//   contam como prova.
// - Duplicatas de ID são case-insensitive, mas o par legítimo
//   1-delta + 1-main (reafirmação MODIFIED/ADDED, LESSONS 2026-09-06)
//   continua permitido.
// - Changes com `skip_specs: true` (`.openspec.yaml`, `change.yaml` ou
//   frontmatter de `proposal.md`) têm seus requirements dispensados de teste.
// - Patterns de princípio com risco de ReDoS geram aviso PATTERN_ARRISCADO
//   e execuções lentas geram PRINCIPIO_LENTO em vez de travar o CI.

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
// Delta pode ser ADDED | MODIFIED | REMOVED | RENAMED (só em changes).
// Suporta forma bullet (`- ### Requirement: X`), fechamento `###`,
// bullets `-`/`*`/`+` e seção RENAMED com pares FROM:/TO:.
// Retorna { reqs, warnings, renamedFrom } — warnings carrega
// DELTA_FORA_DE_SECAO / CENARIO_AUSENTE / RENAMED_INVALIDO /
// DELTA_PATH_INVALIDO para o chamador transformar em findings.
const KNOWN_DELTAS = new Set(['ADDED', 'MODIFIED', 'REMOVED', 'RENAMED']);

function slug(s) {
  return s.normalize('NFC').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'unnamed';
}

function stripClosingHashes(title) {
  // Sequência de fechamento CommonMark (`### Req ###`) não faz parte do nome,
  // mas `C#` (sem espaço antes) deve ser preservado.
  return title.replace(/[ \t]+#+[ \t]*$/, '').trim();
}

function idFromTitle(title) {
  const idMatch = title.match(/\[(AC-[A-Z0-9]+|[a-z0-9-]+)\]/);
  return idMatch ? idMatch[1] : slug(title);
}

function parseSpecFile(file, fullPath, isChange) {
  const raw = readFileSync(fullPath, 'utf8');
  const content = raw.normalize('NFC');
  const out = [];
  const warnings = [];
  const renamedFrom = [];
  const reqRe = /^\s*(?:[-*+]\s+)?#{3,5}\s+Requirement:\s+(.+?)\s*$/gm;
  const sectionRe = /^##\s+(ADDED|MODIFIED|REMOVED|RENAMED)\s+Requirements?/gmi;
  const anyH2Re = /^##\s+(.+?)\s*$/gm;
  const sections = [...content.matchAll(sectionRe)];
  const h2s = [...content.matchAll(anyH2Re)];

  const sectionAt = (index) => {
    let delta = null;
    let h2 = null;
    for (const s of sections) if (s.index < index) delta = s[1].toUpperCase();
    for (const h of h2s) if (h.index < index) h2 = h[1];
    return { delta, h2 };
  };

  for (const m of content.matchAll(reqRe)) {
    const title = stripClosingHashes(m[1].trim());
    const { delta, h2 } = sectionAt(m.index);
    if (isChange && delta === null) {
      warnings.push({
        code: 'DELTA_FORA_DE_SECAO', severity: 'warning',
        file, line: fileLineAt(content, m.index),
        message: `requirement "${title}" fora de seção ADDED/MODIFIED/REMOVED/RENAMED` +
          (h2 ? ` (sob "## ${h2}")` : ' (acima do primeiro "##")') +
          ` — bloco ignorado pelo archive`,
      });
      continue; // upstream: bloco não é aplicado
    }
    const id = idFromTitle(title);
    out.push({
      id, title: title.replace(/\s*\[.*?\]\s*$/, '').trim(),
      line: fileLineAt(content, m.index),
      file,
      delta: isChange ? delta : null,
      active: delta !== 'REMOVED',
    });
  }

  // Seção RENAMED: pares FROM:/TO: (bullets -/*/+, TO opcionalmente com bullet).
  for (const s of sections) {
    if (s[1].toUpperCase() !== 'RENAMED') continue;
    const nextH2 = h2s.find((h) => h.index > s.index);
    const body = content.slice(s.index, nextH2 ? nextH2.index : content.length);
    const moves = [];
    for (const lm of body.matchAll(/^\s*(?:[-*+]\s+)?(FROM|TO):\s*(.+?)\s*$/gmi)) {
      moves.push({ kind: lm[1].toUpperCase(), name: stripClosingHashes(lm[2].trim()), line: fileLineAt(content, s.index + lm.index) });
    }
    let pending = null;
    const flush = (mv) => {
      warnings.push({
        code: 'RENAMED_INVALIDO', severity: 'error',
        file, line: mv.line,
        message: `${mv.kind}: sem par em seção RENAMED (cada FROM: exige um TO:) — archive recusaria`,
      });
    };
    for (const mv of moves) {
      if (mv.kind === 'FROM') {
        if (pending) flush(pending);
        pending = mv;
      } else {
        if (!pending) { flush(mv); continue; }
        renamedFrom.push(idFromTitle(pending.name));
        const newId = idFromTitle(mv.name);
        out.push({
          id: newId, title: mv.name.replace(/\s*\[.*?\]\s*$/, '').trim(),
          line: mv.line, file, delta: isChange ? 'RENAMED' : null, active: true,
        });
        pending = null;
      }
    }
    if (pending) flush(pending);
  }

  // Cenário com corpo: requirement sem nenhum `#### Scenario:` com corpo
  // gera aviso (não erro, para não quebrar specs legadas mínimas).
  const scenarioRe = /^#{4,6}\s+Scenario:\s*(.+?)\s*$/gm;
  const scenarios = [...content.matchAll(scenarioRe)];
  for (const r of out) {
    if (!r.active) continue; // REMOVED não precisa de cenário
    const rLine = r.line;
    const rIndex = lineStartIndex(content, rLine);
    const nextReq = [...content.matchAll(reqRe)].map((x) => x.index).find((i) => i > rIndex - 1 && content.slice(0, i).split('\n').length > rLine);
    const end = nextReq ?? content.length;
    let hasBody = false;
    for (const sc of scenarios) {
      if (sc.index <= rIndex || sc.index >= end) continue;
      const scEndMatch = [...content.matchAll(/^#{3,6}\s+\S/gm)].map((x) => x.index).find((i) => i > sc.index);
      const scBody = content.slice(sc.index + sc[0].length, scEndMatch ?? end).replace(/```[\s\S]*?```/g, ' ').trim();
      if (scBody.length > 0) { hasBody = true; break; }
    }
    if (!hasBody) {
      warnings.push({
        code: 'CENARIO_AUSENTE', severity: 'warning',
        file, line: r.line,
        message: `critério "${r.title}" (${r.id}) sem cenário com corpo — validate recusaria no archive`,
      });
    }
  }

  return { reqs: out, warnings, renamedFrom };
}

function lineStartIndex(content, line) {
  let idx = 0;
  for (let i = 1; i < line; i++) {
    const n = content.indexOf('\n', idx);
    if (n === -1) return content.length;
    idx = n + 1;
  }
  return idx;
}

// Change com `skip_specs: true` — trabalho sem mudança de comportamento
// (refator puro, tooling, docs). Marcadores suportados, nesta ordem:
// `<change>/.openspec.yaml`, `<change>/change.yaml` ou frontmatter/bloco
// `skip_specs: true` em `<change>/proposal.md`.
function isChangeSkipped(changesDir, changeName) {
  const candidates = [join(changesDir, changeName, '.openspec.yaml'), join(changesDir, changeName, 'change.yaml')];
  for (const p of candidates) {
    try {
      const c = readFileSync(p, 'utf8').normalize('NFC');
      if (/^\s*skip_specs\s*:\s*true\s*(#.*)?$/mi.test(c)) return true;
    } catch { /* ausente — tenta próximo */ }
  }
  try {
    const proposal = readFileSync(join(changesDir, changeName, 'proposal.md'), 'utf8').normalize('NFC');
    const head = proposal.split('---').slice(0, 3).join('---');
    if (/skip_specs\s*:\s*true/i.test(head)) return true;
  } catch { /* sem proposal — não é skip */ }
  return false;
}

function loadSpecs() {
  const specsDir = join(ROOT, config.specs.dir);
  const changesDir = join(ROOT, config.specs.changesDir);
  const requirements = [];
  const warnings = [];
  const renamedFrom = new Set();
  const skippedIds = new Set();

  for (const f of walk(specsDir).filter(f => f.endsWith('.md'))) {
    const { reqs, warnings: w, renamedFrom: rf } = parseSpecFile(f, join(specsDir, f), false);
    for (const r of reqs) requirements.push({ ...r, file: `${config.specs.dir}/${r.file}` });
    warnings.push(...w.map((x) => ({ ...x, file: `${config.specs.dir}/${x.file}` })));
    rf.forEach((id) => renamedFrom.add(id));
  }
  const changeFiles = walk(changesDir).filter(f => f.endsWith('.md'));
  const skipCache = new Map();
  for (const f of changeFiles) {
    const changeName = f.split('/')[0];
    // Delta fora de `specs/<cap>/spec.md`: arquivo sob specs/ com delta
    // que não é o spec.md da capability nunca é lido pelo archive.
    const parts = f.split('/');
    const specsIdx = parts.lastIndexOf('specs');
    if (specsIdx !== -1 && parts[parts.length - 1] !== 'spec.md') {
      try {
        const c = readFileSync(join(changesDir, f), 'utf8').normalize('NFC');
        if (/^##\s+(ADDED|MODIFIED|REMOVED|RENAMED)\s+Requirements?/mi.test(c) || /^\s*(?:[-*+]\s+)?#{3,5}\s+Requirement:/m.test(c)) {
          warnings.push({
            code: 'DELTA_PATH_INVALIDO', severity: 'error',
            file: `${config.specs.changesDir}/${f}`, line: 1,
            message: `delta em "${f}" — archive só lê specs/<capability>/spec.md; mova os requirements para o spec.md da capability`,
          });
          continue;
        }
      } catch { /* ilegível — parse abaixo reporta */ }
    }
    if (!skipCache.has(changeName)) skipCache.set(changeName, isChangeSkipped(changesDir, changeName));
    const skipped = skipCache.get(changeName);
    const { reqs, warnings: w, renamedFrom: rf } = parseSpecFile(f, join(changesDir, f), true);
    rf.forEach((id) => renamedFrom.add(id));
    for (const x of w) warnings.push({ ...x, file: `${config.specs.changesDir}/${x.file}` });
    for (const r of reqs) {
      const entry = { ...r, file: `${config.specs.changesDir}/${r.file}`, skipped };
      requirements.push(entry);
      if (skipped) skippedIds.add(r.id);
    }
  }
  const active = requirements.filter(r => r.active && !renamedFrom.has(r.id) && !renamedFrom.has(r.id.toLowerCase()));
  return { requirements: active, warnings, skippedIds };
}

// ───────────────────────────── testes ─────────────────────────────

// Teste pulado não é prova (anti-bypass onp-spec-driven): tags @spec:
// dentro de blocos test.skip/describe.skip/it.skip/xit/xdescribe são
// ignoradas. Word-boundary evita confundir `exit(` com `xit(`. O rastreio
// é por profundidade de chaves (aproximado, sem parser JS completo).
const SKIP_OPEN_RE = /\b(?:describe\.skip|test\.skip|it\.skip)\s*\(|\bxdescribe\s*\(|\bxit\s*\(/;

function skippedRanges(lines) {
  // Retorna lista de [startLine, endLine] cobertos por blocos pulados.
  const ranges = [];
  const stack = []; // { skipped, depthAtEntry }
  let depth = 0;
  const scopeSkipped = () => stack.some((s) => s.skipped);
  lines.forEach((line, i) => {
    const opens = line.match(SKIP_OPEN_RE);
    const opensCount = (line.match(/\{/g) || []).length;
    const closesCount = (line.match(/\}/g) || []).length;
    if (opens) {
      stack.push({ skipped: true, depthAtEntry: depth });
      if (scopeSkipped()) ranges.push([i, null]);
    } else if (opensCount > 0 && scopeSkipped()) {
      // bloco aninhado dentro de escopo pulado herda o skip
    }
    depth += opensCount - closesCount;
    while (stack.length > 0 && depth <= stack[stack.length - 1].depthAtEntry) stack.pop();
    // fecha ranges cujo escopo saiu
    for (const r of ranges) {
      if (r[1] === null && !scopeSkipped()) r[1] = i;
    }
  });
  for (const r of ranges) if (r[1] === null) r[1] = lines.length - 1;
  return ranges;
}

function loadTestAnnotations(files) {
  const found = new Map(); // id -> [{ file, line }]
  const skippedTags = [];
  for (const f of files) {
    const content = readFileSync(join(ROOT, f), 'utf8').normalize('NFC');
    const lines = content.split('\n');
    const ranges = skippedRanges(lines);
    const inSkipped = (lineIdx) => ranges.some(([a, b]) => lineIdx >= a && lineIdx <= b);
    const re = /@spec:([A-Za-z0-9_-]+)/g;
    let m;
    while ((m = re.exec(content)) !== null) {
      const id = m[1];
      const lineIdx = fileLineAt(content, m.index) - 1;
      const sameLine = lines[lineIdx] || '';
      // Tag em linha de comentário imediatamente acima de um teste pulado
      // (`// @spec:x` + `test.skip(...)`) pertence ao teste pulado.
      let followsSkipped = false;
      if (/^\s*(\/\/|#|\*)/.test(sameLine)) {
        for (let j = lineIdx + 1; j < Math.min(lineIdx + 4, lines.length); j++) {
          const nxt = lines[j];
          if (/^\s*$/.test(nxt) || /^\s*(\/\/|#|\*)/.test(nxt)) {
            if (SKIP_OPEN_RE.test(nxt)) { followsSkipped = true; break; }
            continue;
          }
          if (SKIP_OPEN_RE.test(nxt)) followsSkipped = true;
          break;
        }
      }
      if (inSkipped(lineIdx) || SKIP_OPEN_RE.test(sameLine) || followsSkipped) {
        skippedTags.push({ file: f, line: lineIdx + 1, id });
        continue; // pulado não conta como prova
      }
      if (!found.has(id)) found.set(id, []);
      found.get(id).push({ file: f, line: lineIdx + 1 });
    }
  }
  return { found, skippedTags };
}

// ───────────────────────────── princípios ─────────────────────────────

// Heurística anti-ReDoS (melhor esforço — regex JS é síncrona e não pode
// ser interrompida; patterns sinalizados geram aviso em vez de travar o CI).
// Só sinaliza aninhamento real de quantificadores (`(a+)+`) ou múltiplos
// `.*`/repetições abertas DENTRO do mesmo ramo de alternância —
// `A.*B|C.*D`, `[\s\S]{0,500}` e `[^'"]{8,}` são lineares e NÃO são sinalizados.
function splitTopAlternation(src) {
  const branches = [];
  let depthParen = 0, inClass = false, cur = '';
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '\\') { cur += c + (src[i + 1] ?? ''); i++; continue; }
    if (c === '[' && !inClass) inClass = true;
    else if (c === ']' && inClass) inClass = false;
    else if (!inClass && c === '(') depthParen++;
    else if (!inClass && c === ')') depthParen = Math.max(0, depthParen - 1);
    if (c === '|' && !inClass && depthParen === 0) { branches.push(cur); cur = ''; continue; }
    cur += c;
  }
  branches.push(cur);
  return branches;
}

function isRiskyPattern(src) {
  for (const branch of splitTopAlternation(src)) {
    if (/\([^()]*[+*?][^()]*\)[+*?]/.test(branch)) return true; // (a+)+ aninhado
    const open = (branch.match(/(\.\*|\[\\s\\S\]\*|\[\\S\\s\]\*|\.\+)/g) || []).length;
    if (open >= 2) return true;
  }
  return false;
}

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
    if (isRiskyPattern(p.pattern)) {
      findings.push({ code: 'PATTERN_ARRISCADO', severity: 'warning', principle: p.id,
        message: `pattern do princípio ${p.id} tem construção com risco de ReDoS (quantificador aninhado/repetição aberta) — simplifique ou ancore o pattern` });
    }
    const ignored = (p.ignore || []).map(globToRegex);
    for (const f of matched) {
      if (ignored.some(r => r.test(f))) continue;
      const content = readFileSync(join(ROOT, f), 'utf8').normalize('NFC');
      const t0 = Date.now();
      const m = re.exec(content);
      const dt = Date.now() - t0;
      if (dt > 1000) {
        findings.push({ code: 'PRINCIPIO_LENTO', severity: 'warning', principle: p.id,
          file: f, message: `verificação do princípio ${p.id} em ${f} levou ${dt}ms — considere ancorar o pattern ou restringir o glob` });
      }
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

  const { requirements: allReqs, warnings: specWarnings, skippedIds } = loadSpecs();
  const requirements = allReqs.filter((r) => !r.skipped);
  const skippedCount = allReqs.filter((r) => r.skipped).length;
  const { found: annotations, skippedTags } = loadTestAnnotations(testFiles);
  const findings = [];

  // 0. Avisos/erros do parse (RENAMED, path, fora de seção, sem cenário)
  findings.push(...specWarnings);

  // 0b. Tags em testes pulados: ignoradas como prova, sinalizadas
  for (const t of skippedTags) {
    findings.push({
      code: 'TESTE_PULADO', severity: 'warning',
      file: t.file, line: t.line,
      message: `tag @spec:${t.id} está dentro de teste pulado (skip/xit) e não conta como prova — reative o teste ou mova a tag`,
    });
  }

  // 1. AC sem teste (changes com skip_specs: true dispensados)
  for (const r of requirements) {
    if (!annotations.has(r.id)) {
      findings.push({
        code: 'AC_SEM_TESTE', severity: 'error',
        file: r.file, line: r.line,
        message: `critério de aceite "${r.title}" (${r.id}) não tem nenhum teste anotado com @spec:${r.id}`,
      });
    }
  }

  // 2. Testes órfãos (IDs de skip_specs contam como ativos)
  const activeIds = new Set([...requirements.map(r => r.id), ...skippedIds]);
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

  // 3. IDs duplicados (comparação case-insensitive — `Late Fees` vs
  // `late fees` — mas o par legítimo 1-delta + 1-main segue permitido,
  // LESSONS 2026-09-06: MODIFIED reafirma o texto completo e ADDED espelha
  // a main recém-criada pelo sync antes do archive).
  const seen = new Map();
  const dupGroups = new Map();
  for (const r of requirements) {
    const key = r.id.toLowerCase();
    if (seen.has(key)) {
      if (!dupGroups.has(key)) dupGroups.set(key, [seen.get(key)]);
      dupGroups.get(key).push(r);
    } else seen.set(key, r);
  }
  for (const [key, rs] of dupGroups) {
    const dupId = rs[0].id;
    const deltas = rs.filter((r) => r.delta !== null);
    const mainSpecs = rs.filter((r) => r.delta === null);
    const legitimateRestatement = rs.length === 2 && deltas.length === 1 && mainSpecs.length === 1;
    if (!legitimateRestatement) {
      for (const r of rs) {
        findings.push({
          code: 'ID_DUPLICADO', severity: 'error',
          file: r.file, line: r.line,
          message: `ID ${dupId} duplicado (${rs.map((x) => x.file).join(', ')}) — ambiguidade na rastreabilidade`,
        });
      }
    }
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
        skipped: skippedCount,
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
    console.log(`\nresumo: ${requirements.length} critério(s) de aceite · ${requirements.filter(r => annotations.has(r.id)).length} com teste · ${skippedCount} dispensado(s) (skip_specs) · ${testFiles.length} arquivo(s) de teste · ${errors.length} erro(s), ${warnings.length} aviso(s)`);
    if (errors.length > 0) console.log('✘ auditoria falhou — corrija os erros antes de declarar pronto.');
    else console.log('✔ auditoria ok.');
  }

  process.exit(errors.length > 0 ? 1 : 0);
}

try { main(); } catch (e) { die(String(e.stack || e), 2); }
