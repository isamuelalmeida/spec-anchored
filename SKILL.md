---
name: spec-anchored
description: >-
  Fluxo spec-anchored para opencode: usa OpenSpec como backbone (changes,
  propose/apply/archive via /opsx-*) e mantém a especificação verdadeira por
  auditoria MECÂNICA contra código e testes — todo critério de aceite precisa
  de teste anotado @spec:<id>, testes órfãos são sinalizados, e princípios do
  projeto são verificados por glob/regex no CI. Use quando o usuário disser
  "especificar feature", "abrir change", "implementar com verificação",
  "auditar spec", "verificar spec", "o que não tem teste", "critério de aceite
  sem teste", "teste órfão", "constituição", "princípios verificáveis",
  "definição de pronto", ou mencionar /opsx, OpenSpec, spec-driven. NÃO use
  para technical design docs, análise de arquitetura ou refactors sem critérios
  de aceite.
license: MIT
metadata:
  author: spec-anchored
  version: 1.0.0
---

# spec-anchored — a spec que continua verdadeira

Spec-first: a especificação gera código, o código evolui e a spec vira mentira.
Spec-anchored: a especificação é auditada **mecanicamente** contra o código e
os testes, o tempo todo. O motor de auditoria (`scripts/audit-specs.mjs`, Node
puro, zero dependências) é o que garante isso — e roda também no CI, sem
agente.

Baseada nas melhores práticas de dois projetos open source (MIT): o
[OpenSpec](https://github.com/Fission-AI/OpenSpec) (formato de specs, deltas,
workflow de changes e integração com opencode — usamos o CLI e os `/opsx-*`
que ele instala) e o
[onp-spec-driven](https://github.com/onovoprogramador/onp-spec-driven)
(inspiração para o conceito spec-anchored: auditoria mecânica de
rastreabilidade spec↔código, códigos como `AC_SEM_TESTE`/`TESTE_ORFAO` e
princípios verificáveis; o motor daqui é implementação própria adaptada ao
formato do OpenSpec).

## Pré-requisitos

1. CLI do OpenSpec instalado: `npm install -g @fission-ai/openspec@latest`.
2. Projeto inicializado: `openspec init --tools opencode` (cria
   `.opencode/skills/openspec-*` + `.opencode/commands/opsx-*.md` + `openspec/`).
   Se faltar, faça o init antes de qualquer outra coisa.
3. (Opcional) `spec-audit.config.json` na raiz com os princípios do projeto —
   veja `spec-audit.config.example.json` nesta skill.

## Workflow diário

Siga o ciclo do OpenSpec e rode a auditoria em cada parada:

1. `/opsx:explore` — pensar antes de especificar (opcional).
2. `/opsx:propose <nome>` — cria `openspec/changes/<nome>/` com proposal,
   design, tasks e specs delta (requisitos `### Requirement:` + cenários
   GIVEN/WHEN/THEN).
3. **Convenção de IDs**: cada `### Requirement: Título` vira um critério de
   aceite. O ID é o slug do título (`two-factor-authentication`) ou o marcador
   explícito `[AC-001]` no próprio título. Recomendo marcador explícito quando
   o título puder mudar.
4. **Definição de pronto executável**: cada critério de aceite DEVE ter um
   teste anotado com a tag `@spec:<id>` (em comentário do arquivo de teste ou
   no nome). Sem teste anotado, a feature não está pronta.
5. `/opsx:apply` — implementar tarefa a tarefa; `@spec:` tags entram junto
   com os testes.
6. **Rodar a auditoria** (abaixo) antes de dizer que terminou e antes do
   `/opsx:archive`.
7. `/opsx:archive` — delta vira spec principal.

## Auditoria

O motor está em `scripts/audit-specs.mjs` dentro do diretório base desta
skill. Para usar no CI ou em scripts, copie-o para o projeto (ex.:
`scripts/spec-audit/audit-specs.mjs`).

```bash
# varredura estática (rápida, sem rodar testes)
node <base-da-skill>/scripts/audit-specs.mjs

# com a suíte de testes (recomendado no CI)
node <base-da-skill>/scripts/audit-specs.mjs --test-command "npm run test:ci"

# relatório máquina (para CI/JSON)
node <base-da-skill>/scripts/audit-specs.mjs --json
```

Saída: `0` se ok, `1` se houver erros (CI pode falhar direto), avisos não
bloqueiam (exceto com `--strict`). Códigos e o que fazer:

| Código | Severidade | Significado | Correção |
|---|---|---|---|
| `AC_SEM_TESTE` | erro | critério de aceite sem teste `@spec:<id>` | criar teste anotado |
| `TESTE_ORFAO` | aviso | tag `@spec:` sem critério ativo | remover tag ou restaurar requirement |
| `ID_DUPLICADO` | erro | mesmo ID em dois requirements | renomear um dos IDs |
| `PRINCIPIO_VIOLADO` | erro | princípio do config não vale no código | corrigir código ou ajustar princípio |
| `GLOB_SEM_ARQUIVOS` | aviso | glob do princípio não casa nada | corrigir typo no glob |
| `TESTES_FALHANDO` | erro | suíte (--test-command) falhou | corrigir testes |

## Princípios verificáveis (constituição)

Conceitos do AGENTS.md que podem virar checagem mecânica ficam em
`spec-audit.config.json` na raiz. Três tipos de regra:

```json
{
  "principles": [
    { "id": "P-SEM-SEGREDO", "type": "no_regex", "glob": "src/**/*.{ts,js}",
      "pattern": "api[_-]?key\\s*[:=]|password\\s*[:=]\\s*['\"][^'\"]{8,}",
      "message": "nenhum segredo hardcoded no código" },
    { "id": "P-VALIDA-INPUT", "type": "regex_required", "glob": "src/api/**/*.ts",
      "pattern": "zod|ajv|validate|parse",
      "message": "todo endpoint deve validar entrada antes de processar" },
    { "id": "P-MIGRACOES", "type": "file_exists", "glob": "db/migrations/**/*.{sql,ts}",
      "message": "o projeto precisa de camada de migrações" }
  ]
}
```

Os exemplos são genéricos de propósito — troque pelos princípios do SEU
projeto. Regra de ouro: princípio só entra se a checagem for objetiva (glob +
regex ou existência). Se depender de interpretação, é conversa, não princípio.

## CI

```yaml
- name: auditoria spec
  run: node scripts/spec-audit/audit-specs.mjs --test-command "npm run test:ci"
```

## Regras de ouro

- Não declare "pronto" com `AC_SEM_TESTE` pendente.
- Mudou o requirement → atualize o teste na mesma mudança.
- Apagou teste → apague/arquive o requirement junto (senão vira `TESTE_ORFAO`).
- Rodou a auditoria → cite o resumo no chat (N critérios, N com teste).
