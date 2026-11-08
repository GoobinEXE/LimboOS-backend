# Fase 0: provabilidade das regras multi-tenant (resultados)

Execução em 2026-11-07, Firestore Emulator `cloud-firestore-emulator-v1.22.0` (firebase-tools 15.26.0), Node 26.8.1, `@firebase/rules-unit-testing` 6.0.0 e `firebase` 13.2.0. Projeto `demo-limboos`, regras lidas de `firestore.spike.rules`. Resultado: **80 testes, 80 aprovados, 0 falhas**.

## Como rodar

```bash
cd backend/rules-tests && npm install && npm test
```

O `npm test` chama `firebase emulators:exec --only firestore --project demo-limboos "$npm_node_execpath --test"`. O comando da tarefa (`"node --test"`) falhou na primeira execução com `Error: Cannot find module '.../rules-tests/--test'` e `Node.js v20.18.2`: o `firebase` do Homebrew é o binário standalone (pkg) e o `node` dentro do script resolve para o Node 20 embutido nele, que não entende `--test` como flag. Passar o caminho absoluto do Node do sistema resolve. O emulador usa a porta 8085 (`firebase.json`) para não colidir com outro serviço em 8080.

## Correção registrada no plano

O caminho `library/intel/{id}` da seção "Estrutura de dados proposta" é inválido: em `workspaces/{ws}/library/intel/{id}`, `library` seria coleção, `intel` documento e `{id}` cairia num número ímpar de segmentos (coleção sem documento pai do tipo esperado). O spike usa coleções planas dentro da pasta: `workspaces/{ws}/intel/{id}`, `workspaces/{ws}/achievements/{id}`, `workspaces/{ws}/npcs/{id}` etc. A Fase 1 deve adotar esse formato (ou `library/{kind}/items/{id}`, que é válido mas não traz vantagem nas regras).

## Personas e dados semeados

Dono A (`ownerA`, pasta `workspaces/ownerA`), dono B (`ownerB`), co-mestre de A só na campanha X (`members/cogmX { campaignIds: ['X'] }`) e jogador de A na campanha X (`players/playerX { campaignIds: ['X'] }`). A pasta B usa de propósito o mesmo id de campanha `X`, para provar que o isolamento não depende de ids de campanha únicos entre pastas. Agentes em `users/{uid}/characters/{charId}` com `workspaceId`, `campaignId` e `gmUids`: `chX` (A, X), `chY` (A, Y) e `chB` (B, X).

## Matriz consolidada

"get" é leitura de documento; "list" é a query que o painel faria. Entre parênteses, os documentos devolvidos.

| Variante (regra) | Dono A | Dono B | Co-mestre de X | Jogador de X |
|---|---|---|---|---|
| **A** `campaignIds[]` + `hasAny(get(members).campaignIds)` | get permitido; list sem filtro permitido (3) | get negado; list negado | get X permitido, get Y negado; list `array-contains 'X'` **permitido** (a-x, a-xy); `array-contains-any ['X']` permitido; `array-contains 'Y'` negado; sem filtro negado | get negado; list negado |
| **C** `campaignId` + `in get(members).campaignIds` | get permitido; list permitido (2) | get negado; list negado | get X permitido, get Y negado; list `campaignId == 'X'` **permitido** (c-x); `in ['X']` permitido; `== 'Y'` negado; sem filtro negado | get negado; list negado |
| **B** `request.auth.uid in gmUids` | get permitido; list permitido (2) | get negado; list `gmUids array-contains ownerB` permitido e vazio | get X permitido, get Y negado; list `gmUids array-contains uid` **permitido** (b-x); `campaignIds array-contains 'X'` negado; sem filtro negado | get negado; list com o próprio uid permitido e vazio |
| **P** `campaigns/{c}/qr`, `c in get(members).campaignIds` | get e list permitidos | get negado; list negado | get e list de `campaigns/X/qr` **permitidos** (q-x); `campaigns/Y/qr` negado; `collectionGroup('qr')` negado; doc `campaigns/X` permitido; list de `campaigns` negado | qr negado; `campaigns/X/state/live` permitido; `campaigns/Y/state/live` negado |
| **CG** `collectionGroup('characters')` com `workspaceId` | `workspaceId == ownerA` **permitido** (chX, chY); sem filtro negado | `workspaceId == ownerA` negado; get de chX negado | get chX permitido, get chY negado; `workspaceId == A && campaignId == 'X'` **permitido** (chX); `campaignId in ['X']` permitido; `gmUids array-contains uid` permitido (chX); só `workspaceId == A` negado; `campaignId == 'Y'` negado | `users/playerX/characters` permitido (chX); collectionGroup negado |
| **J** conquistas da campanha (`players/{uid}.campaignIds`) | n/a | `array-contains 'X'` em A negado | `array-contains 'X'` permitido (ach-x) | get ach-x permitido, ach-y negado; `array-contains 'X'` com `hasAny` **permitido** (ach-x); `achievementsC campaignId == 'X'` com `in` **permitido** (achc-x); `array-contains 'Y'` negado; sem filtro negado |
| **G** gestão | `members` list permitido; `invites/tok1` negado | `workspaces/ownerA` negado; `members` de A negado | próprio `members/cogmX` permitido; list de `members` negado; `invites/tok1` negado | list de `players` negado |

## Leitura dos resultados

**`hasAny` e `in` com `get()` são prováveis em list.** O avaliador de queries resolve o `get(members/{auth.uid})` (o caminho depende só de `request.auth.uid` e do wildcard `ws`) e compara a lista do membro com o filtro da query: `array-contains 'X'` prova `campaignIds.hasAny(['X'])`, `campaignId == 'X'` prova `campaignId in ['X']`. Uma query por campanha que o co-mestre não tem (`'Y'`) e a query sem filtro são negadas, como deveriam. O mesmo vale para o jogador lendo conquistas via `players/{uid}.campaignIds`.

**O `get()` no collectionGroup também é provável** quando o caminho usa `resource.data.workspaceId` e a query fixa esse campo por igualdade. `workspaceId == ownerA && campaignId == 'X'` passa para o co-mestre; só `workspaceId == ownerA` é negado porque a pasta contém agentes de Y.

**A variante B funciona, mas não isola por pasta.** A regra só olha `gmUids`, então o dono B consegue executar `where('gmUids','array-contains', ownerB)` sobre a pasta A e recebe 0 documentos. Nada vaza, mas a separação entre pastas passa a depender de a Cloud Function manter `gmUids` correto em todo documento. Nos testes isso foi tratado como "permitido e vazio" (primeira execução marcou esses dois casos como falha porque a expectativa inicial era "negado"; a saída está na seção final).

**P é a forma mais barata para conteúdo que pertence a uma única campanha.** A regra usa o wildcard `c`, sem campo no documento, e a query do co-mestre é um list simples da subcoleção. O custo é que `collectionGroup('qr')` fica fora do alcance do co-mestre (negado), o que é aceitável porque o painel do co-mestre sempre opera dentro de uma campanha.

## Recomendação

1. **Biblioteca compartilhável entre campanhas (intel, conquistas, NPCs, diálogos, jukebox): variante A**, `campaignIds[]` no documento e regra `isOwner(ws) || (isMember(ws) && resource.data.campaignIds.hasAny(memberCampaigns(ws)))`. O co-mestre consulta com `array-contains` da campanha ativa; com várias campanhas, `array-contains-any` com a lista dele (limite de 30 valores por query). Dispensa a Cloud Function de sincronização que B exigiria.
2. **Conteúdo de uma única campanha (qrRedirects, playEvents, activityLog, state/live, state/settings): variante P**, por caminho `workspaces/{ws}/campaigns/{c}/...`, como já está no plano.
3. **Agentes: `collectionGroup('characters')` com `workspaceId` e `campaignId`**, regra com `get()` no `members` da pasta indicada no documento. O painel do dono filtra por `workspaceId == uid`; o do co-mestre acrescenta `campaignId == X`.
4. **C fica descartada** para a biblioteca porque não representa item em várias campanhas; serve como alternativa onde o item é sempre de uma só campanha e não se quer subcoleção.
5. **B não é necessária.** Se for usada em algum ponto, a regra deve somar a checagem de pasta (`isMember(ws) && request.auth.uid in resource.data.gmUids`).

## Limites deste spike

O emulador não exige índices: em produção, `collectionGroup('characters')` com `workspaceId == ... && campaignId == ...` precisa de índice composto de collection group, e os `array-contains` precisam do índice de campo único (automático). Cada avaliação de regra admite até 10 chamadas `get()`/`exists()` em leituras e queries; a regra de collectionGroup usa duas sobre o mesmo documento. Não foram testados: co-mestre com mais de uma campanha (`array-contains-any` com duas listas parciais), escrita (create/update com validação de `campaignIds` contra a lista do membro), Storage com `firestore.get`, e o comportamento em um projeto real (staging), que é a confirmação final de que o emulador espelha produção.

## Saída real da execução final

```text

> test
> firebase emulators:exec --only firestore --project demo-limboos "$npm_node_execpath --test"

i  emulators: Starting emulators: firestore
i  emulators: Detected demo project ID "demo-limboos", emulated services will use a demo configuration and attempts to access non-emulated services for this project will fail.
i  firestore: Firestore Emulator logging to firestore-debug.log
✔  firestore: Firestore Emulator was started in standard edition.
✔  firestore: Firestore Emulator UI websocket is running on 9150.
i  Running script: /opt/homebrew/Cellar/node/26.8.1/bin/node --test
▶ variante A
  ✔ donoA get intelA/a-y → allow (76.226333ms)
  ✔ donoA list intelA (sem filtro) → allow (39.328708ms)
  ✔ donoB get intelA/a-x de A → deny (33.099208ms)
  ✔ donoB list intelA de A array-contains X → deny (24.424125ms)
  ✔ coMestre get intelA/a-x → allow (18.97225ms)
  ✔ coMestre get intelA/a-xy (X e Y) → allow (18.075291ms)
  ✔ coMestre get intelA/a-y → deny (14.62275ms)
  ✔ coMestre list array-contains X → probe (14.032334ms)
  ✔ coMestre list array-contains-any [X] → probe (12.667541ms)
  ✔ coMestre list array-contains Y → deny (16.023958ms)
  ✔ coMestre list sem filtro → deny (13.806125ms)
  ✔ jogador get intelA/a-x (biblioteca) → deny (14.957041ms)
  ✔ jogador list intelA array-contains X → deny (13.803333ms)
✔ variante A (744.53725ms)
▶ variante C
  ✔ donoA get intelC/c-y → allow (11.730833ms)
  ✔ donoA list intelC (sem filtro) → allow (13.748292ms)
  ✔ donoB get intelC/c-x de A → deny (12.923917ms)
  ✔ donoB list intelC de A campaignId == X → deny (13.276ms)
  ✔ coMestre get intelC/c-x → allow (14.968208ms)
  ✔ coMestre get intelC/c-y → deny (12.865917ms)
  ✔ coMestre list campaignId == 'X' → probe (13.119625ms)
  ✔ coMestre list campaignId in ['X'] → probe (10.707291ms)
  ✔ coMestre list campaignId == 'Y' → deny (12.99475ms)
  ✔ coMestre list sem filtro → deny (14.099583ms)
  ✔ jogador get intelC/c-x (biblioteca) → deny (11.586208ms)
  ✔ jogador list intelC campaignId == 'X' → deny (11.830083ms)
✔ variante C (154.404833ms)
▶ variante B
  ✔ donoA get intelB/b-y → allow (9.945333ms)
  ✔ donoA list intelB (sem filtro) → allow (14.287666ms)
  ✔ donoB get intelB/b-x de A → deny (11.63425ms)
  ✔ donoB list intelB de A gmUids array-contains ownerB → empty (11.097666ms)
  ✔ coMestre get intelB/b-x → allow (12.165167ms)
  ✔ coMestre get intelB/b-y → deny (11.213417ms)
  ✔ coMestre list gmUids array-contains uid → probe (8.773625ms)
  ✔ coMestre list campaignIds array-contains X (sem gmUids) → deny (9.483167ms)
  ✔ coMestre list sem filtro → deny (11.4045ms)
  ✔ jogador get intelB/b-x (biblioteca) → deny (12.471042ms)
  ✔ jogador list gmUids array-contains playerX → empty (10.547834ms)
✔ variante B (123.445334ms)
▶ variante P
  ✔ donoA get campaigns/Y/qr/q-y → allow (10.828542ms)
  ✔ donoA list campaigns/Y/qr → allow (13.350459ms)
  ✔ donoB get campaigns/X/qr/q-x de A → deny (11.368333ms)
  ✔ donoB list campaigns/X/qr de A → deny (10.553375ms)
  ✔ coMestre get campaigns/X/qr/q-x → allow (11.958417ms)
  ✔ coMestre get campaigns/Y/qr/q-y → deny (11.100917ms)
  ✔ coMestre list campaigns/X/qr (sem filtro) → probe (9.340916ms)
  ✔ coMestre list campaigns/Y/qr → deny (10.586084ms)
  ✔ coMestre list collectionGroup(qr) → deny (9.811375ms)
  ✔ jogador get campaigns/X/qr/q-x → deny (11.902667ms)
  ✔ jogador list campaigns/X/qr → deny (12.056708ms)
  ✔ jogador get campaigns/X/state/live → allow (13.605958ms)
  ✔ jogador get campaigns/Y/state/live → deny (11.814ms)
  ✔ coMestre get campaigns/X (doc da campanha) → allow (13.715334ms)
  ✔ coMestre list campaigns (sem filtro) → deny (11.533667ms)
✔ variante P (174.036792ms)
▶ variante CG
  ✔ donoA list cg characters workspaceId == ownerA → probe (9.430667ms)
  ✔ donoA list cg characters sem filtro → deny (9.862ms)
  ✔ donoB list cg characters workspaceId == ownerA → deny (11.377ms)
  ✔ donoB get users/playerX/characters/chX → deny (11.500041ms)
  ✔ coMestre get users/playerX/characters/chX → allow (10.830584ms)
  ✔ coMestre get users/p2/characters/chY → deny (9.948ms)
  ✔ coMestre list cg workspaceId == ownerA && campaignId == X → probe (12.403416ms)
  ✔ coMestre list cg workspaceId == ownerA && campaignId in [X] → probe (9.849166ms)
  ✔ coMestre list cg gmUids array-contains uid (B) → probe (8.240125ms)
  ✔ coMestre list cg workspaceId == ownerA (sem campanha) → deny (11.092833ms)
  ✔ coMestre list cg workspaceId == ownerA && campaignId == Y → deny (11.620208ms)
  ✔ jogador list users/playerX/characters (próprios) → allow (13.232042ms)
  ✔ jogador list cg workspaceId == ownerA && campaignId == X → deny (11.681791ms)
✔ variante CG (141.512459ms)
▶ variante J
  ✔ jogador get achievements/ach-x → allow (12.200459ms)
  ✔ jogador get achievements/ach-y → deny (10.978292ms)
  ✔ jogador list achievements array-contains X (hasAny) → probe (9.240666ms)
  ✔ jogador list achievementsC campaignId == X (in) → probe (9.888708ms)
  ✔ jogador list achievements array-contains Y → deny (12.317292ms)
  ✔ jogador list achievements sem filtro → deny (10.640458ms)
  ✔ coMestre list achievements array-contains X → probe (9.278958ms)
  ✔ donoB list achievements de A array-contains X → deny (11.599084ms)
✔ variante J (86.459084ms)
▶ variante G
  ✔ coMestre get members/cogmX (próprio) → allow (10.804125ms)
  ✔ coMestre list members → deny (8.384125ms)
  ✔ coMestre get invites/tok1 → deny (8.670708ms)
  ✔ donoA get invites/tok1 → deny (9.017ms)
  ✔ donoA list members → allow (13.139875ms)
  ✔ donoB get workspaces/ownerA → deny (8.648417ms)
  ✔ donoB list members de A → deny (9.681583ms)

|---|---|---|---|---|---|---|
  ✔ jogador list players de A → deny (9.383875ms)
✔ variante G (78.021916ms)
ℹ tests 80
ℹ suites 7
ℹ pass 80
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 1610.650209
✔  Script exited successfully (code 0)
i  emulators: Shutting down emulators.
i  firestore: Stopping Firestore Emulator
i  hub: Stopping emulator hub
i  logging: Stopping Logging Emulator
```

Tabela impressa pelo hook `after` da mesma execução (`results.json` guarda a mesma informação):

| Variante | Persona | Op | Alvo | Esperado | Resultado | Detalhe |
| A | donoA | get | intelA/a-y | allow | permitido | existe |
| A | donoA | list | intelA (sem filtro) | allow | permitido | 3 doc(s): a-x, a-xy, a-y |
| A | donoB | get | intelA/a-x de A | deny | negado |  |
| A | donoB | list | intelA de A array-contains X | deny | negado |  |
| A | coMestre | get | intelA/a-x | allow | permitido | existe |
| A | coMestre | get | intelA/a-xy (X e Y) | allow | permitido | existe |
| A | coMestre | get | intelA/a-y | deny | negado |  |
| A | coMestre | list | array-contains X | probe | permitido | 2 doc(s): a-x, a-xy |
| A | coMestre | list | array-contains-any [X] | probe | permitido | 2 doc(s): a-x, a-xy |
| A | coMestre | list | array-contains Y | deny | negado |  |
| A | coMestre | list | sem filtro | deny | negado |  |
| A | jogador | get | intelA/a-x (biblioteca) | deny | negado |  |
| A | jogador | list | intelA array-contains X | deny | negado |  |
| C | donoA | get | intelC/c-y | allow | permitido | existe |
| C | donoA | list | intelC (sem filtro) | allow | permitido | 2 doc(s): c-x, c-y |
| C | donoB | get | intelC/c-x de A | deny | negado |  |
| C | donoB | list | intelC de A campaignId == X | deny | negado |  |
| C | coMestre | get | intelC/c-x | allow | permitido | existe |
| C | coMestre | get | intelC/c-y | deny | negado |  |
| C | coMestre | list | campaignId == 'X' | probe | permitido | 1 doc(s): c-x |
| C | coMestre | list | campaignId in ['X'] | probe | permitido | 1 doc(s): c-x |
| C | coMestre | list | campaignId == 'Y' | deny | negado |  |
| C | coMestre | list | sem filtro | deny | negado |  |
| C | jogador | get | intelC/c-x (biblioteca) | deny | negado |  |
| C | jogador | list | intelC campaignId == 'X' | deny | negado |  |
| B | donoA | get | intelB/b-y | allow | permitido | existe |
| B | donoA | list | intelB (sem filtro) | allow | permitido | 2 doc(s): b-x, b-y |
| B | donoB | get | intelB/b-x de A | deny | negado |  |
| B | donoB | list | intelB de A gmUids array-contains ownerB | empty | permitido | 0 doc(s):  |
| B | coMestre | get | intelB/b-x | allow | permitido | existe |
| B | coMestre | get | intelB/b-y | deny | negado |  |
| B | coMestre | list | gmUids array-contains uid | probe | permitido | 1 doc(s): b-x |
| B | coMestre | list | campaignIds array-contains X (sem gmUids) | deny | negado |  |
| B | coMestre | list | sem filtro | deny | negado |  |
| B | jogador | get | intelB/b-x (biblioteca) | deny | negado |  |
| B | jogador | list | gmUids array-contains playerX | empty | permitido | 0 doc(s):  |
| P | donoA | get | campaigns/Y/qr/q-y | allow | permitido | existe |
| P | donoA | list | campaigns/Y/qr | allow | permitido | 1 doc(s): q-y |
| P | donoB | get | campaigns/X/qr/q-x de A | deny | negado |  |
| P | donoB | list | campaigns/X/qr de A | deny | negado |  |
| P | coMestre | get | campaigns/X/qr/q-x | allow | permitido | existe |
| P | coMestre | get | campaigns/Y/qr/q-y | deny | negado |  |
| P | coMestre | list | campaigns/X/qr (sem filtro) | probe | permitido | 1 doc(s): q-x |
| P | coMestre | list | campaigns/Y/qr | deny | negado |  |
| P | coMestre | list | collectionGroup(qr) | deny | negado | No matching allow statements |
| P | jogador | get | campaigns/X/qr/q-x | deny | negado |  |
| P | jogador | list | campaigns/X/qr | deny | negado |  |
| P | jogador | get | campaigns/X/state/live | allow | permitido | existe |
| P | jogador | get | campaigns/Y/state/live | deny | negado |  |
| P | coMestre | get | campaigns/X (doc da campanha) | allow | permitido | existe |
| P | coMestre | list | campaigns (sem filtro) | deny | negado |  |
| CG | donoA | list | cg characters workspaceId == ownerA | probe | permitido | 2 doc(s): chY, chX |
| CG | donoA | list | cg characters sem filtro | deny | negado |  |
| CG | donoB | list | cg characters workspaceId == ownerA | deny | negado |  |
| CG | donoB | get | users/playerX/characters/chX | deny | negado |  |
| CG | coMestre | get | users/playerX/characters/chX | allow | permitido | existe |
| CG | coMestre | get | users/p2/characters/chY | deny | negado |  |
| CG | coMestre | list | cg workspaceId == ownerA && campaignId == X | probe | permitido | 1 doc(s): chX |
| CG | coMestre | list | cg workspaceId == ownerA && campaignId in [X] | probe | permitido | 1 doc(s): chX |
| CG | coMestre | list | cg gmUids array-contains uid (B) | probe | permitido | 1 doc(s): chX |
| CG | coMestre | list | cg workspaceId == ownerA (sem campanha) | deny | negado |  |
| CG | coMestre | list | cg workspaceId == ownerA && campaignId == Y | deny | negado |  |
| CG | jogador | list | users/playerX/characters (próprios) | allow | permitido | 1 doc(s): chX |
| CG | jogador | list | cg workspaceId == ownerA && campaignId == X | deny | negado |  |
| J | jogador | get | achievements/ach-x | allow | permitido | existe |
| J | jogador | get | achievements/ach-y | deny | negado |  |
| J | jogador | list | achievements array-contains X (hasAny) | probe | permitido | 1 doc(s): ach-x |
| J | jogador | list | achievementsC campaignId == X (in) | probe | permitido | 1 doc(s): achc-x |
| J | jogador | list | achievements array-contains Y | deny | negado |  |
| J | jogador | list | achievements sem filtro | deny | negado |  |
| J | coMestre | list | achievements array-contains X | probe | permitido | 1 doc(s): ach-x |
| J | donoB | list | achievements de A array-contains X | deny | negado |  |
| G | coMestre | get | members/cogmX (próprio) | allow | permitido | existe |
| G | coMestre | list | members | deny | negado |  |
| G | coMestre | get | invites/tok1 | deny | negado |  |
| G | donoA | get | invites/tok1 | deny | negado |  |
| G | donoA | list | members | allow | permitido | 1 doc(s): cogmX |
| G | donoB | get | workspaces/ownerA | deny | negado |  |
| G | donoB | list | members de A | deny | negado |  |
| G | jogador | list | players de A | deny | negado |  |

## Primeira execução com o Node correto (antes do ajuste da variante B)

Saída: `EXIT=1`. As duas linhas abaixo foram as falhas (esperado "deny", obtido "permitido" com 0 documentos); todas as outras 78 coincidiram com a execução final.

```text
| B | donoB | list | intelB de A gmUids array-contains ownerB | deny | permitido | 0 doc(s):  |
| B | jogador | list | gmUids array-contains playerX | deny | permitido | 0 doc(s):  |
```
