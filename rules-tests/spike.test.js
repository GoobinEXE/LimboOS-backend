// Fase 0: spike de provabilidade das regras multi-tenant.
// Rodar: npx firebase emulators:exec --only firestore --project demo-limboos "node --test"
import { readFileSync, writeFileSync } from 'node:fs';
import { after, before, describe, test } from 'node:test';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
} from '@firebase/rules-unit-testing';
import {
  collection,
  collectionGroup,
  doc,
  getDoc,
  getDocs,
  query,
  setDoc,
  where,
} from 'firebase/firestore';

const OWNER_A = 'ownerA';
const OWNER_B = 'ownerB';
const COGM = 'cogmX'; // co-mestre de A apenas na campanha X
const PLAYER = 'playerX'; // jogador de A na campanha X

const PERSONAS = {
  donoA: OWNER_A,
  donoB: OWNER_B,
  coMestre: COGM,
  jogador: PLAYER,
};

let env;
const results = [];

async function seed() {
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    const put = (path, data) => setDoc(doc(db, path), data);
    const A = `workspaces/${OWNER_A}`;
    const B = `workspaces/${OWNER_B}`;

    await put(A, { ownerUid: OWNER_A, name: 'Pasta A' });
    await put(B, { ownerUid: OWNER_B, name: 'Pasta B' });
    await put(`${A}/members/${COGM}`, { campaignIds: ['X'], invitedBy: OWNER_A });
    await put(`${A}/players/${PLAYER}`, { campaignIds: ['X'], characterIds: ['chX'] });

    // Variante A
    await put(`${A}/intelA/a-x`, { campaignIds: ['X'] });
    await put(`${A}/intelA/a-y`, { campaignIds: ['Y'] });
    await put(`${A}/intelA/a-xy`, { campaignIds: ['X', 'Y'] });
    // Variante C
    await put(`${A}/intelC/c-x`, { campaignId: 'X' });
    await put(`${A}/intelC/c-y`, { campaignId: 'Y' });
    // Variante B
    await put(`${A}/intelB/b-x`, { campaignIds: ['X'], gmUids: [COGM] });
    await put(`${A}/intelB/b-y`, { campaignIds: ['Y'], gmUids: [] });
    // Variante P
    await put(`${A}/campaigns/X`, { name: 'Campanha X' });
    await put(`${A}/campaigns/Y`, { name: 'Campanha Y' });
    await put(`${A}/campaigns/X/qr/q-x`, { target: 'intel/a-x' });
    await put(`${A}/campaigns/Y/qr/q-y`, { target: 'intel/a-y' });
    await put(`${A}/campaigns/X/state/live`, { phase: 'ativo' });
    await put(`${A}/campaigns/Y/state/live`, { phase: 'ativo' });
    // Conquistas
    await put(`${A}/achievements/ach-x`, { campaignIds: ['X'] });
    await put(`${A}/achievements/ach-y`, { campaignIds: ['Y'] });
    await put(`${A}/achievementsC/achc-x`, { campaignId: 'X' });
    await put(`${A}/achievementsC/achc-y`, { campaignId: 'Y' });

    // Pasta B usa o mesmo id de campanha "X" de propósito: o isolamento não pode
    // depender de ids de campanha serem únicos entre pastas.
    await put(`${B}/intelA/bb-x`, { campaignIds: ['X'] });
    await put(`${B}/intelC/bbc-x`, { campaignId: 'X' });
    await put(`${B}/intelB/bbb-x`, { campaignIds: ['X'], gmUids: [] });
    await put(`${B}/campaigns/X/qr/bq-x`, { target: 'x' });
    await put(`${B}/achievements/bach-x`, { campaignIds: ['X'] });

    // Agentes (collectionGroup)
    await put(`users/${PLAYER}`, { displayName: 'Jogador X' });
    await put(`users/${PLAYER}/characters/chX`, {
      workspaceId: OWNER_A, campaignId: 'X', gmUids: [COGM],
    });
    await put(`users/p2/characters/chY`, {
      workspaceId: OWNER_A, campaignId: 'Y', gmUids: [],
    });
    await put(`users/p3/characters/chB`, {
      workspaceId: OWNER_B, campaignId: 'X', gmUids: [],
    });

    await put('invites/tok1', { kind: 'cogm', wsId: OWNER_A, campaignId: 'X' });
  });
}

const dbFor = (uid) => env.authenticatedContext(uid).firestore();
const A = `workspaces/${OWNER_A}`;

// Cada caso: variante, persona, operação, descrição, expectativa e consulta.
// expect 'allow' | 'deny' são asserções de segurança/funcionais (falham o teste);
// 'empty' exige query permitida e vazia (nada vaza);
// 'probe' só registra o resultado (sonda de provabilidade).
const CASES = [
  // ---- Variante A: campaignIds[] + hasAny(get) ----
  ['A', 'donoA', 'get', 'intelA/a-y', 'allow', (db) => getDoc(doc(db, `${A}/intelA/a-y`))],
  ['A', 'donoA', 'list', 'intelA (sem filtro)', 'allow', (db) => getDocs(collection(db, `${A}/intelA`))],
  ['A', 'donoB', 'get', 'intelA/a-x de A', 'deny', (db) => getDoc(doc(db, `${A}/intelA/a-x`))],
  ['A', 'donoB', 'list', 'intelA de A array-contains X', 'deny', (db) => getDocs(query(collection(db, `${A}/intelA`), where('campaignIds', 'array-contains', 'X')))],
  ['A', 'coMestre', 'get', 'intelA/a-x', 'allow', (db) => getDoc(doc(db, `${A}/intelA/a-x`))],
  ['A', 'coMestre', 'get', 'intelA/a-xy (X e Y)', 'allow', (db) => getDoc(doc(db, `${A}/intelA/a-xy`))],
  ['A', 'coMestre', 'get', 'intelA/a-y', 'deny', (db) => getDoc(doc(db, `${A}/intelA/a-y`))],
  ['A', 'coMestre', 'list', 'array-contains X', 'probe', (db) => getDocs(query(collection(db, `${A}/intelA`), where('campaignIds', 'array-contains', 'X')))],
  ['A', 'coMestre', 'list', 'array-contains-any [X]', 'probe', (db) => getDocs(query(collection(db, `${A}/intelA`), where('campaignIds', 'array-contains-any', ['X'])))],
  ['A', 'coMestre', 'list', 'array-contains Y', 'deny', (db) => getDocs(query(collection(db, `${A}/intelA`), where('campaignIds', 'array-contains', 'Y')))],
  ['A', 'coMestre', 'list', 'sem filtro', 'deny', (db) => getDocs(collection(db, `${A}/intelA`))],
  ['A', 'jogador', 'get', 'intelA/a-x (biblioteca)', 'deny', (db) => getDoc(doc(db, `${A}/intelA/a-x`))],
  ['A', 'jogador', 'list', 'intelA array-contains X', 'deny', (db) => getDocs(query(collection(db, `${A}/intelA`), where('campaignIds', 'array-contains', 'X')))],

  // ---- Variante C: campaignId único + in get ----
  ['C', 'donoA', 'get', 'intelC/c-y', 'allow', (db) => getDoc(doc(db, `${A}/intelC/c-y`))],
  ['C', 'donoA', 'list', 'intelC (sem filtro)', 'allow', (db) => getDocs(collection(db, `${A}/intelC`))],
  ['C', 'donoB', 'get', 'intelC/c-x de A', 'deny', (db) => getDoc(doc(db, `${A}/intelC/c-x`))],
  ['C', 'donoB', 'list', 'intelC de A campaignId == X', 'deny', (db) => getDocs(query(collection(db, `${A}/intelC`), where('campaignId', '==', 'X')))],
  ['C', 'coMestre', 'get', 'intelC/c-x', 'allow', (db) => getDoc(doc(db, `${A}/intelC/c-x`))],
  ['C', 'coMestre', 'get', 'intelC/c-y', 'deny', (db) => getDoc(doc(db, `${A}/intelC/c-y`))],
  ['C', 'coMestre', 'list', "campaignId == 'X'", 'probe', (db) => getDocs(query(collection(db, `${A}/intelC`), where('campaignId', '==', 'X')))],
  ['C', 'coMestre', 'list', "campaignId in ['X']", 'probe', (db) => getDocs(query(collection(db, `${A}/intelC`), where('campaignId', 'in', ['X'])))],
  ['C', 'coMestre', 'list', "campaignId == 'Y'", 'deny', (db) => getDocs(query(collection(db, `${A}/intelC`), where('campaignId', '==', 'Y')))],
  ['C', 'coMestre', 'list', 'sem filtro', 'deny', (db) => getDocs(collection(db, `${A}/intelC`))],
  ['C', 'jogador', 'get', 'intelC/c-x (biblioteca)', 'deny', (db) => getDoc(doc(db, `${A}/intelC/c-x`))],
  ['C', 'jogador', 'list', "intelC campaignId == 'X'", 'deny', (db) => getDocs(query(collection(db, `${A}/intelC`), where('campaignId', '==', 'X')))],

  // ---- Variante B: gmUids[] desnormalizado ----
  ['B', 'donoA', 'get', 'intelB/b-y', 'allow', (db) => getDoc(doc(db, `${A}/intelB/b-y`))],
  ['B', 'donoA', 'list', 'intelB (sem filtro)', 'allow', (db) => getDocs(collection(db, `${A}/intelB`))],
  ['B', 'donoB', 'get', 'intelB/b-x de A', 'deny', (db) => getDoc(doc(db, `${A}/intelB/b-x`))],
  ['B', 'donoB', 'list', 'intelB de A gmUids array-contains ownerB', 'empty', (db) => getDocs(query(collection(db, `${A}/intelB`), where('gmUids', 'array-contains', OWNER_B)))],
  ['B', 'coMestre', 'get', 'intelB/b-x', 'allow', (db) => getDoc(doc(db, `${A}/intelB/b-x`))],
  ['B', 'coMestre', 'get', 'intelB/b-y', 'deny', (db) => getDoc(doc(db, `${A}/intelB/b-y`))],
  ['B', 'coMestre', 'list', 'gmUids array-contains uid', 'probe', (db) => getDocs(query(collection(db, `${A}/intelB`), where('gmUids', 'array-contains', COGM)))],
  ['B', 'coMestre', 'list', 'campaignIds array-contains X (sem gmUids)', 'deny', (db) => getDocs(query(collection(db, `${A}/intelB`), where('campaignIds', 'array-contains', 'X')))],
  ['B', 'coMestre', 'list', 'sem filtro', 'deny', (db) => getDocs(collection(db, `${A}/intelB`))],
  ['B', 'jogador', 'get', 'intelB/b-x (biblioteca)', 'deny', (db) => getDoc(doc(db, `${A}/intelB/b-x`))],
  ['B', 'jogador', 'list', 'gmUids array-contains playerX', 'empty', (db) => getDocs(query(collection(db, `${A}/intelB`), where('gmUids', 'array-contains', PLAYER)))],

  // ---- Variante P: por caminho campaigns/{c}/qr ----
  ['P', 'donoA', 'get', 'campaigns/Y/qr/q-y', 'allow', (db) => getDoc(doc(db, `${A}/campaigns/Y/qr/q-y`))],
  ['P', 'donoA', 'list', 'campaigns/Y/qr', 'allow', (db) => getDocs(collection(db, `${A}/campaigns/Y/qr`))],
  ['P', 'donoB', 'get', 'campaigns/X/qr/q-x de A', 'deny', (db) => getDoc(doc(db, `${A}/campaigns/X/qr/q-x`))],
  ['P', 'donoB', 'list', 'campaigns/X/qr de A', 'deny', (db) => getDocs(collection(db, `${A}/campaigns/X/qr`))],
  ['P', 'coMestre', 'get', 'campaigns/X/qr/q-x', 'allow', (db) => getDoc(doc(db, `${A}/campaigns/X/qr/q-x`))],
  ['P', 'coMestre', 'get', 'campaigns/Y/qr/q-y', 'deny', (db) => getDoc(doc(db, `${A}/campaigns/Y/qr/q-y`))],
  ['P', 'coMestre', 'list', 'campaigns/X/qr (sem filtro)', 'probe', (db) => getDocs(collection(db, `${A}/campaigns/X/qr`))],
  ['P', 'coMestre', 'list', 'campaigns/Y/qr', 'deny', (db) => getDocs(collection(db, `${A}/campaigns/Y/qr`))],
  ['P', 'coMestre', 'list', 'collectionGroup(qr)', 'deny', (db) => getDocs(collectionGroup(db, 'qr'))],
  ['P', 'jogador', 'get', 'campaigns/X/qr/q-x', 'deny', (db) => getDoc(doc(db, `${A}/campaigns/X/qr/q-x`))],
  ['P', 'jogador', 'list', 'campaigns/X/qr', 'deny', (db) => getDocs(collection(db, `${A}/campaigns/X/qr`))],
  ['P', 'jogador', 'get', 'campaigns/X/state/live', 'allow', (db) => getDoc(doc(db, `${A}/campaigns/X/state/live`))],
  ['P', 'jogador', 'get', 'campaigns/Y/state/live', 'deny', (db) => getDoc(doc(db, `${A}/campaigns/Y/state/live`))],
  ['P', 'coMestre', 'get', 'campaigns/X (doc da campanha)', 'allow', (db) => getDoc(doc(db, `${A}/campaigns/X`))],
  ['P', 'coMestre', 'list', "campaigns (sem filtro)", 'deny', (db) => getDocs(collection(db, `${A}/campaigns`))],

  // ---- collectionGroup('characters') com workspaceId ----
  ['CG', 'donoA', 'list', "cg characters workspaceId == ownerA", 'probe', (db) => getDocs(query(collectionGroup(db, 'characters'), where('workspaceId', '==', OWNER_A)))],
  ['CG', 'donoA', 'list', 'cg characters sem filtro', 'deny', (db) => getDocs(collectionGroup(db, 'characters'))],
  ['CG', 'donoB', 'list', "cg characters workspaceId == ownerA", 'deny', (db) => getDocs(query(collectionGroup(db, 'characters'), where('workspaceId', '==', OWNER_A)))],
  ['CG', 'donoB', 'get', 'users/playerX/characters/chX', 'deny', (db) => getDoc(doc(db, `users/${PLAYER}/characters/chX`))],
  ['CG', 'coMestre', 'get', 'users/playerX/characters/chX', 'allow', (db) => getDoc(doc(db, `users/${PLAYER}/characters/chX`))],
  ['CG', 'coMestre', 'get', 'users/p2/characters/chY', 'deny', (db) => getDoc(doc(db, `users/p2/characters/chY`))],
  ['CG', 'coMestre', 'list', "cg workspaceId == ownerA && campaignId == X", 'probe', (db) => getDocs(query(collectionGroup(db, 'characters'), where('workspaceId', '==', OWNER_A), where('campaignId', '==', 'X')))],
  ['CG', 'coMestre', 'list', "cg workspaceId == ownerA && campaignId in [X]", 'probe', (db) => getDocs(query(collectionGroup(db, 'characters'), where('workspaceId', '==', OWNER_A), where('campaignId', 'in', ['X'])))],
  ['CG', 'coMestre', 'list', "cg gmUids array-contains uid (B)", 'probe', (db) => getDocs(query(collectionGroup(db, 'characters'), where('gmUids', 'array-contains', COGM)))],
  ['CG', 'coMestre', 'list', "cg workspaceId == ownerA (sem campanha)", 'deny', (db) => getDocs(query(collectionGroup(db, 'characters'), where('workspaceId', '==', OWNER_A)))],
  ['CG', 'coMestre', 'list', "cg workspaceId == ownerA && campaignId == Y", 'deny', (db) => getDocs(query(collectionGroup(db, 'characters'), where('workspaceId', '==', OWNER_A), where('campaignId', '==', 'Y')))],
  ['CG', 'jogador', 'list', 'users/playerX/characters (próprios)', 'allow', (db) => getDocs(collection(db, `users/${PLAYER}/characters`))],
  ['CG', 'jogador', 'list', "cg workspaceId == ownerA && campaignId == X", 'deny', (db) => getDocs(query(collectionGroup(db, 'characters'), where('workspaceId', '==', OWNER_A), where('campaignId', '==', 'X')))],

  // ---- Jogador: conquistas da campanha ----
  ['J', 'jogador', 'get', 'achievements/ach-x', 'allow', (db) => getDoc(doc(db, `${A}/achievements/ach-x`))],
  ['J', 'jogador', 'get', 'achievements/ach-y', 'deny', (db) => getDoc(doc(db, `${A}/achievements/ach-y`))],
  ['J', 'jogador', 'list', 'achievements array-contains X (hasAny)', 'probe', (db) => getDocs(query(collection(db, `${A}/achievements`), where('campaignIds', 'array-contains', 'X')))],
  ['J', 'jogador', 'list', 'achievementsC campaignId == X (in)', 'probe', (db) => getDocs(query(collection(db, `${A}/achievementsC`), where('campaignId', '==', 'X')))],
  ['J', 'jogador', 'list', 'achievements array-contains Y', 'deny', (db) => getDocs(query(collection(db, `${A}/achievements`), where('campaignIds', 'array-contains', 'Y')))],
  ['J', 'jogador', 'list', 'achievements sem filtro', 'deny', (db) => getDocs(collection(db, `${A}/achievements`))],
  ['J', 'coMestre', 'list', 'achievements array-contains X', 'probe', (db) => getDocs(query(collection(db, `${A}/achievements`), where('campaignIds', 'array-contains', 'X')))],
  ['J', 'donoB', 'list', 'achievements de A array-contains X', 'deny', (db) => getDocs(query(collection(db, `${A}/achievements`), where('campaignIds', 'array-contains', 'X')))],

  // ---- Gestão: membros e convites ----
  ['G', 'coMestre', 'get', 'members/cogmX (próprio)', 'allow', (db) => getDoc(doc(db, `${A}/members/${COGM}`))],
  ['G', 'coMestre', 'list', 'members', 'deny', (db) => getDocs(collection(db, `${A}/members`))],
  ['G', 'coMestre', 'get', 'invites/tok1', 'deny', (db) => getDoc(doc(db, 'invites/tok1'))],
  ['G', 'donoA', 'get', 'invites/tok1', 'deny', (db) => getDoc(doc(db, 'invites/tok1'))],
  ['G', 'donoA', 'list', 'members', 'allow', (db) => getDocs(collection(db, `${A}/members`))],
  ['G', 'donoB', 'get', 'workspaces/ownerA', 'deny', (db) => getDoc(doc(db, A))],
  ['G', 'donoB', 'list', 'members de A', 'deny', (db) => getDocs(collection(db, `${A}/members`))],
  ['G', 'jogador', 'list', 'players de A', 'deny', (db) => getDocs(collection(db, `${A}/players`))],
];

function describeResult(snap) {
  if (snap && typeof snap.size === 'number') return `${snap.size} doc(s): ${snap.docs.map((d) => d.ref.path.split('/').pop()).join(', ')}`;
  if (snap && typeof snap.exists === 'function') return snap.exists() ? 'existe' : 'não existe';
  return '';
}

before(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-limboos',
    firestore: { rules: readFileSync(new URL('./firestore.spike.rules', import.meta.url), 'utf8') },
  });
  await env.clearFirestore();
  await seed();
});

after(async () => {
  writeFileSync(new URL('./results.json', import.meta.url), JSON.stringify(results, null, 2));
  console.log('\n| Variante | Persona | Op | Alvo | Esperado | Resultado | Detalhe |');
  console.log('|---|---|---|---|---|---|---|');
  for (const r of results) {
    console.log(`| ${r.variant} | ${r.persona} | ${r.op} | ${r.label} | ${r.expect} | ${r.outcome} | ${r.detail} |`);
  }
  await env?.cleanup();
});

for (const variant of [...new Set(CASES.map((c) => c[0]))]) {
  describe(`variante ${variant}`, () => {
    for (const [v, persona, op, label, expect, run] of CASES.filter((c) => c[0] === variant)) {
      test(`${persona} ${op} ${label} → ${expect}`, async () => {
        const db = dbFor(PERSONAS[persona]);
        let outcome;
        let detail = '';
        try {
          const snap = await run(db);
          outcome = 'permitido';
          detail = describeResult(snap);
        } catch (err) {
          outcome = err?.code === 'permission-denied' ? 'negado' : `erro:${err?.code ?? err?.message}`;
          detail = (err?.message ?? '').split('\n')[0].slice(0, 160).replace(/\|/g, '/');
        }
        results.push({ variant: v, persona, op, label, expect, outcome, detail });
        if (expect === 'allow') await assertSucceeds(run(db));
        if (expect === 'deny') await assertFails(run(db));
        if (expect === 'empty') {
          const snap = await assertSucceeds(run(db));
          if (snap.size !== 0) throw new Error(`esperava 0 docs, veio ${snap.size}`);
        }
      });
    }
  });
}
