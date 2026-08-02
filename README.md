# spec-anchored

Skill para **opencode** que une o que há de melhor em spec-driven development:

- **Backbone maduro**: [OpenSpec](https://openspec.dev) (63k+ ⭐, YC-backed) com
  integração oficial ao opencode (`openspec init --tools opencode` instala
  skills + comandos `/opsx-*` em `.opencode/`).
- **Diferencial de verificação**: auditoria **mecânica** spec↔código (o que
  ferramentas spec-first não têm) — todo critério de aceite exige teste
  anotado `@spec:<id>`, testes órfãos são sinalizados, e princípios do projeto
  (ex.: proibir segredos no código, exigir validação de entrada) viram
  checagens glob/regex que rodam no CI.

Spec-first deixa a especificação virar mentira com o tempo. Spec-anchored
verifica, mecanicamente, que ela continua verdadeira.

## Créditos / Inspiração

Esta skill combina as melhores práticas de dois projetos open source (MIT):

- [**Fission-AI/OpenSpec**](https://github.com/Fission-AI/OpenSpec) — backbone do
  fluxo: formato de specs (requirements + cenários GIVEN/WHEN/THEN), deltas
  ADDED/MODIFIED/REMOVED, workflow de changes (`propose → apply → archive`) e a
  integração oficial com opencode. Esta skill não reimplementa o OpenSpec — o
  agente usa o CLI e os comandos `/opsx-*` que ele instala.
- [**onovoprogramador/onp-spec-driven**](https://github.com/onovoprogramador/onp-spec-driven) —
  inspiração para o conceito **spec-anchored** (auditoria mecânica de
  rastreabilidade spec↔código): todo critério de aceite com teste anotado,
  códigos de auditoria como `AC_SEM_TESTE` / `TESTE_ORFAO`, princípios
  verificáveis. O motor aqui (`scripts/audit-specs.mjs`) é uma implementação
  própria, zero-dependência, adaptada ao formato de specs do OpenSpec.

## Instalação

```bash
git clone https://github.com/<seu-usuario>/spec-anchored ~/.config/opencode/skills/spec-anchored
# ou por symlink, se preferir manter o clone em outro lugar:
ln -s ~/spec-anchored ~/.config/opencode/skills/spec-anchored
```

Também funciona por projeto: `.opencode/skills/spec-anchored/`.

Reinicie o opencode. No projeto-alvo:

```bash
npm install -g @fission-ai/openspec@latest
openspec init --tools opencode   # cria .opencode/skills/openspec-* + comandos /opsx-*
cp ~/.config/opencode/skills/spec-anchored/scripts/audit-specs.mjs scripts/spec-audit/  # para uso no CI
```

## Uso

No chat do opencode:

```
/opsx:propose minha-feature      # spec (requirements + cenários GIVEN/WHEN/THEN)
/opsx:apply                      # implementa com testes anotados @spec:<id>
# auditoria
node scripts/spec-audit/audit-specs.mjs --test-command "npm run test:ci"
/opsx:archive                    # delta vira spec principal
```

IDs: `### Requirement: Título` → id = slug (`título`) ou `[AC-001]` explícito
no título. Testes anotam `@spec:<id>`.

Princípios verificáveis: `spec-audit.config.json` na raiz (veja
`spec-audit.config.example.json`). Tipos: `file_exists`, `no_regex`,
`regex_required`.

## CI

```yaml
- name: auditoria spec
  run: node scripts/spec-audit/audit-specs.mjs --test-command "npm run test:ci"
```

Exit codes: `0` ok · `1` erros (AC sem teste, princípio violado, suíte
falhando) · avisos não bloqueiam (exceto `--strict`).

## Desenvolvimento

```bash
npm test        # node --test (zero dependências)
node scripts/audit-specs.mjs --root <projeto> --json
```

## Licença

MIT
