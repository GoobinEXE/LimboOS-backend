// Testes das regras de produção (backend/firestore.rules), Fase 1.
// Rodar: cd backend/rules-tests && npm test
import { readFileSync } from 'node:fs';
import { after, before, describe, test } from 'node:test';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
} from '@firebase/rules-unit-testing';
import {
  addDoc,
  collection,
  collectionGroup,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
} from 'firebase/firestore';

const A = 'ownerA';
const B = 'ownerB';
const COGM = 'cogmX';
const PLAYER = 'playerX';
const PLAYER_Y = 'playerY';
const PLATFORM = 'platformAdmin';
const SUSPENDED = 'suspendedCogm';
const LEGACY = 'legacyAdmin';

const WA = `workspaces/${A}`;
const WB = `workspaces/${B}`;

let env;

function db(persona) {
  switch (persona) {
    case 'platform':
      return env.authenticatedContext(PLATFORM, { platformAdmin: true }).firestore();
    case 'legacy':
      return env.authenticatedContext(LEGACY, { admin: true }).firestore();
    case 'anon':
      return env.unauthenticatedContext().firestore();
    default:
      return env.authenticatedContext(persona).firestore();
  }
}

const get = (persona, path) => getDoc(doc(db(persona), path));
const list = (persona, path, ...constraints) =>
  getDocs(query(collection(db(persona), path), ...constraints));

before(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-limboos-rules',
    firestore: {
      host: '127.0.0.1',
      port: 8085,
      rules: readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8'),
    },
  });

  await env.withSecurityRulesDisabled(async (ctx) => {
    const d = ctx.firestore();
    const put = (path, data) => setDoc(doc(d, path), data);

    await put(`users/${A}`, { uid: A, role: 'player' });
    await put(`users/${B}`, { uid: B, role: 'player' });
    await put(`users/${COGM}`, { uid: COGM });
    await put(`users/${PLAYER}`, { uid: PLAYER, masterName: 'jogador' });
    await put(`users/${PLAYER_Y}`, { uid: PLAYER_Y });
    await put(`users/${SUSPENDED}`, { uid: SUSPENDED, suspended: true });
    // role 'admin' legado não dá acesso a nada no modelo novo.
    await put(`users/legacyRole`, { uid: 'legacyRole', role: 'admin' });

    await put(WA, { ownerUid: A, name: 'Pasta A' });
    await put(WB, { ownerUid: B, name: 'Pasta B' });
    await put(`${WA}/members/${COGM}`, { campaignIds: ['X'] });
    await put(`${WA}/members/${SUSPENDED}`, { campaignIds: ['X'] });
    await put(`${WA}/players/${PLAYER}`, { campaignIds: ['X'], characterIds: ['chX'] });
    await put(`${WA}/players/${PLAYER_Y}`, { campaignIds: ['Y'], characterIds: ['chY'] });

    await put(`${WA}/campaigns/X`, { name: 'Campanha X' });
    await put(`${WA}/campaigns/Y`, { name: 'Campanha Y' });
    await put(`${WA}/campaigns/X/state/live`, { seized: false });
    await put(`${WA}/campaigns/Y/state/live`, { seized: false });
    // Pasta B repete o id "X" de propósito.
    await put(`${WB}/campaigns/X`, { name: 'Campanha X de B' });
    await put(`${WB}/campaigns/X/state/live`, { seized: true });

    await put(`${WA}/achievementDefs/ach-x`, { campaignIds: ['X'], global: false, title: 'x' });
    await put(`${WA}/achievementDefs/ach-y`, { campaignIds: ['Y'], global: false, title: 'y' });
    await put(`${WA}/achievementDefs/ach-xy`, { campaignIds: ['X', 'Y'], global: false, title: 'xy' });
    await put(`${WA}/achievementDefs/ach-g`, { campaignIds: [], global: true, title: 'g' });
    await put(`${WB}/achievementDefs/bach-x`, { campaignIds: ['X'], global: false });

    await put(`${WA}/npcContacts/npc-x`, { campaignIds: ['X'], global: false });
    await put(`${WA}/npcContacts/npc-y`, { campaignIds: ['Y'], global: false });
    await put(`${WA}/npcDialogues/dlg-x`, { npcId: 'npc-x', campaignIds: ['X'], global: false });

    await put(`${WA}/mediaAssets/m-x`, { campaignId: 'X', title: 'fita x' });
    await put(`${WA}/mediaAssets/m-y`, { campaignId: 'Y' });
    await put(`${WA}/mediaAssets/m-lib`, { campaignId: null });
    await put(`${WB}/mediaAssets/bm-x`, { campaignId: 'X' });
    await put(`${WA}/mediaFolders/f-x`, { campaignId: 'X', name: 'X' });
    await put(`${WA}/mediaFolders/f-lib`, { campaignId: null, name: 'livre' });

    await put(`${WA}/qrRedirects/qr-x`, { campaignId: 'X', targetId: 'm-x' });
    await put(`${WA}/qrRedirects/qr-y`, { campaignId: 'Y', targetId: 'm-y' });

    await put(`${WA}/activityLog/log-x`, { campaignId: 'X', uid: COGM });
    await put(`${WA}/activityLog/log-lib`, { campaignId: null, uid: A });
    await put(`${WA}/playEvents/pe-x`, { campaignId: 'X', uid: PLAYER, completed: false });
    await put(`${WA}/stats/analytics`, { totalPlays: 1 });

    await put(`${WA}/groups/g-x`, {
      name: 'Esquadrão X', campaignIds: ['X'], memberUids: [PLAYER], characterSlots: [],
    });
    await put(`${WA}/groups/g-y`, {
      name: 'Esquadrão Y', campaignIds: ['Y'], memberUids: [PLAYER_Y], characterSlots: [],
    });
    await put(`${WA}/groups/g-x/messages/msg1`, { senderId: 'npc', text: 'oi' });

    await put(`${WA}/jukeboxTracks/t-g`, { campaignIds: [], global: true, title: 'trilha' });

    await put(`users/${PLAYER}/characters/chX`, {
      codinome: 'Agente X', workspaceId: A, campaignId: 'X', unlockedCampaigns: ['X'],
      agentStatus: 'vivo', dangerLevel: 1, archived: false,
    });
    await put(`users/${PLAYER_Y}/characters/chY`, {
      codinome: 'Agente Y', workspaceId: A, campaignId: 'Y', unlockedCampaigns: ['Y'],
      agentStatus: 'vivo', dangerLevel: 1, archived: false,
    });
    await put(`users/${PLAYER}/characters/chB`, {
      codinome: 'Agente na mesa B', workspaceId: B, campaignId: 'X', unlockedCampaigns: ['X'],
    });
    await put(`users/${PLAYER}/characters/chX/intel/m-x`, { intelId: 'm-x', campaignId: 'X', workspaceId: A });
    await put(`users/${PLAYER}/characters/chX/achievements/ach-x__X`, {
      achievementId: 'ach-x', campaignId: 'X', workspaceId: A,
    });
    await put(`users/${PLAYER}/characters/chB/intel/bm-x`, { intelId: 'bm-x', campaignId: 'X', workspaceId: B });
    await put(`users/${PLAYER}/memberships/${A}`, { role: 'player' });

    await put('invites/hash1', { wsId: A, campaignId: 'X', kind: 'cogm' });
    await put('platformStats/global', { totalUsers: 7 });

    await put('mediaAssets/legacy1', { title: 'legado' });
    await put('system/limboState', { seized: false });
  });
});

after(async () => {
  await env?.cleanup();
});

describe('isolamento entre pastas (dono B contra pasta A)', () => {
  test('não lê o documento da pasta', () => assertFails(get(B, WA)));
  test('não lê campanha de A com o mesmo id', () => assertFails(get(B, `${WA}/campaigns/X`)));
  test('lê a própria campanha X', () => assertSucceeds(get(B, `${WB}/campaigns/X`)));
  test('não lista mídia de A', () => assertFails(list(B, `${WA}/mediaAssets`)));
  test('não lista mídia de A filtrando campanha', () =>
    assertFails(list(B, `${WA}/mediaAssets`, where('campaignId', '==', 'X'))));
  test('não lista conquistas de A', () => assertFails(list(B, `${WA}/achievementDefs`)));
  test('não lista NPCs de A', () => assertFails(list(B, `${WA}/npcContacts`)));
  test('não lista QR de A', () => assertFails(list(B, `${WA}/qrRedirects`)));
  test('não lista log de A', () => assertFails(list(B, `${WA}/activityLog`)));
  test('não lista esquadrões de A', () => assertFails(list(B, `${WA}/groups`)));
  test('não lista roster de A', () => assertFails(list(B, `${WA}/players`)));
  test('não anota jogador do roster de A', () =>
    assertFails(updateDoc(doc(db(B), `${WA}/players/${PLAYER}`), { notes: 'x' })));
  test('não lê nem grava preferências de A', async () => {
    await assertFails(get(B, `${WA}/config/settings`));
    await assertFails(setDoc(doc(db(B), `${WA}/config/settings`), { persistentItemIds: [] }));
  });
  test('não lista co-mestres de A', () => assertFails(list(B, `${WA}/members`)));
  test('não lê estatísticas de A', () => assertFails(get(B, `${WA}/stats/analytics`)));
  test('não lê agente da mesa A', () => assertFails(get(B, `users/${PLAYER}/characters/chX`)));
  test('não lê intel do agente da mesa A', () =>
    assertFails(get(B, `users/${PLAYER}/characters/chX/intel/m-x`)));
  test('lê o agente da própria mesa', () => assertSucceeds(get(B, `users/${PLAYER}/characters/chB`)));
  test('não consulta agentes de A por collectionGroup', () =>
    assertFails(getDocs(query(collectionGroup(db(B), 'characters'), where('workspaceId', '==', A)))));
  test('consulta os próprios agentes por collectionGroup', async () => {
    const snap = await assertSucceeds(
      getDocs(query(collectionGroup(db(B), 'characters'), where('workspaceId', '==', B))),
    );
    if (snap.size !== 1) throw new Error(`esperado 1 agente, veio ${snap.size}`);
  });
  test('não escreve na pasta A', () =>
    assertFails(setDoc(doc(db(B), `${WA}/mediaAssets/invasor`), { campaignId: null })));
  test('não cria pasta com o uid de outro', () =>
    assertFails(setDoc(doc(db(B), `workspaces/${A}x`), { ownerUid: `${A}x`, name: 'falsa' })));
});

describe('dono A', () => {
  test('lê a pasta', () => assertSucceeds(get(A, WA)));
  test('lista toda a mídia', () => assertSucceeds(list(A, `${WA}/mediaAssets`)));
  test('lista conquistas sem filtro', () => assertSucceeds(list(A, `${WA}/achievementDefs`)));
  test('lista co-mestres', () => assertSucceeds(list(A, `${WA}/members`)));
  test('lista roster', () => assertSucceeds(list(A, `${WA}/players`)));
  test('lê estatísticas', () => assertSucceeds(get(A, `${WA}/stats/analytics`)));
  test('consulta agentes da pasta por collectionGroup', async () => {
    const snap = await assertSucceeds(
      getDocs(query(collectionGroup(db(A), 'characters'), where('workspaceId', '==', A))),
    );
    if (snap.size !== 2) throw new Error(`esperado 2 agentes, veio ${snap.size}`);
  });
  test('consulta conquistas concedidas da pasta', () =>
    assertSucceeds(getDocs(query(collectionGroup(db(A), 'achievements'), where('workspaceId', '==', A)))));
  test('lê intel de agente da pasta', () =>
    assertSucceeds(get(A, `users/${PLAYER}/characters/chX/intel/m-x`)));
  test('grava intel em agente da pasta', () =>
    assertSucceeds(setDoc(doc(db(A), `users/${PLAYER}/characters/chX/intel/m-y`), { intelId: 'm-y', campaignId: 'Y' })));
  test('não grava intel em agente da mesa B', () =>
    assertFails(setDoc(doc(db(A), `users/${PLAYER}/characters/chB/intel/x`), { intelId: 'x' })));
  test('atualiza agente da pasta', () =>
    assertSucceeds(updateDoc(doc(db(A), `users/${PLAYER}/characters/chX`), { dangerLevel: 2 })));
  test('não move agente para outra pasta', () =>
    assertFails(updateDoc(doc(db(A), `users/${PLAYER}/characters/chX`), { workspaceId: B })));
  test('não lê a conta pessoal do jogador', () => assertFails(get(A, `users/${PLAYER}`)));
  test('não escreve co-mestre direto', () =>
    assertFails(setDoc(doc(db(A), `${WA}/members/alguem`), { campaignIds: ['X'] })));
  test('não lê convites direto', () => assertFails(get(A, 'invites/hash1')));
  test('cria campanha', () => assertSucceeds(setDoc(doc(db(A), `${WA}/campaigns/Z`), { name: 'Z' })));
  test('grava estado da campanha', () =>
    assertSucceeds(setDoc(doc(db(A), `${WA}/campaigns/Y/state/live`), { seized: true })));
  test('renomeia a pasta', () => assertSucceeds(updateDoc(doc(db(A), WA), { name: 'Minha pasta' })));
  test('anota e rotula jogador no roster', () =>
    assertSucceeds(updateDoc(doc(db(A), `${WA}/players/${PLAYER}`), { notes: 'chega atrasado', gmLabel: 'Zé' })));
  test('não mexe nas campanhas do roster', () =>
    assertFails(updateDoc(doc(db(A), `${WA}/players/${PLAYER}`), { campaignIds: ['X', 'Y'] })));
  test('grava preferências da pasta', () =>
    assertSucceeds(setDoc(doc(db(A), `${WA}/config/settings`), { persistentItemIds: ['m-x'] })));
  test('não grava anotação longa demais no roster', () =>
    assertFails(updateDoc(doc(db(A), `${WA}/players/${PLAYER}`), { notes: 'x'.repeat(4000) })));
  test('não grava rótulo longo demais no roster', () =>
    assertFails(updateDoc(doc(db(A), `${WA}/players/${PLAYER}`), { gmLabel: 'x'.repeat(80) })));
  test('não cria jogador no roster direto', () =>
    assertFails(setDoc(doc(db(A), `${WA}/players/novo`), { campaignIds: ['X'] })));
  test('não apaga jogador do roster direto', () =>
    assertFails(deleteDoc(doc(db(A), `${WA}/players/${PLAYER}`))));
  test('não troca o dono da pasta', () => assertFails(updateDoc(doc(db(A), WA), { ownerUid: B })));
});

describe('criação de pasta', () => {
  test('usuário novo cria a própria pasta', () =>
    assertSucceeds(setDoc(doc(db('novoMestre'), 'workspaces/novoMestre'), {
      ownerUid: 'novoMestre', name: 'Pasta nova', createdAt: serverTimestamp(),
    })));
  test('pasta com campo extra é negada', () =>
    assertFails(setDoc(doc(db('outroNovo'), 'workspaces/outroNovo'), {
      ownerUid: 'outroNovo', name: 'x', members: ['y'],
    })));
  test('ninguém lista pastas', () => assertFails(getDocs(collection(db(A), 'workspaces'))));
});

describe('co-mestre de A na campanha X', () => {
  test('lê o documento da pasta', () => assertSucceeds(get(COGM, WA)));
  test('lê o próprio documento de membro', () => assertSucceeds(get(COGM, `${WA}/members/${COGM}`)));
  test('não lista co-mestres', () => assertFails(list(COGM, `${WA}/members`)));
  test('lê a campanha X', () => assertSucceeds(get(COGM, `${WA}/campaigns/X`)));
  test('não lê a campanha Y', () => assertFails(get(COGM, `${WA}/campaigns/Y`)));
  test('não cria campanha', () => assertFails(setDoc(doc(db(COGM), `${WA}/campaigns/W`), { name: 'W' })));
  test('não exclui a campanha X', () => assertFails(deleteDoc(doc(db(COGM), `${WA}/campaigns/X`))));
  test('edita a campanha X', () =>
    assertSucceeds(updateDoc(doc(db(COGM), `${WA}/campaigns/X`), { description: 'nova' })));
  test('lê e grava o estado de X', async () => {
    await assertSucceeds(get(COGM, `${WA}/campaigns/X/state/live`));
    await assertSucceeds(setDoc(doc(db(COGM), `${WA}/campaigns/X/state/live`), { seized: true }));
  });
  test('não lê o estado de Y', () => assertFails(get(COGM, `${WA}/campaigns/Y/state/live`)));

  test('lista conquistas de X', async () => {
    const snap = await assertSucceeds(
      list(COGM, `${WA}/achievementDefs`, where('campaignIds', 'array-contains', 'X')),
    );
    if (snap.size !== 2) throw new Error(`esperado ach-x e ach-xy, veio ${snap.size}`);
  });
  test('lista conquistas globais da pasta', () =>
    assertSucceeds(list(COGM, `${WA}/achievementDefs`, where('global', '==', true))));
  test('não lista conquistas de Y', () =>
    assertFails(list(COGM, `${WA}/achievementDefs`, where('campaignIds', 'array-contains', 'Y'))));
  test('não lista conquistas sem filtro', () => assertFails(list(COGM, `${WA}/achievementDefs`)));
  test('cria conquista em X', () =>
    assertSucceeds(setDoc(doc(db(COGM), `${WA}/achievementDefs/nova-x`), { campaignIds: ['X'], global: false })));
  test('não cria conquista em Y', () =>
    assertFails(setDoc(doc(db(COGM), `${WA}/achievementDefs/nova-y`), { campaignIds: ['Y'], global: false })));
  test('não cria conquista global', () =>
    assertFails(setDoc(doc(db(COGM), `${WA}/achievementDefs/nova-g`), { campaignIds: ['X'], global: true })));
  test('edita conquista compartilhada X+Y sem mexer na lista', () =>
    assertSucceeds(updateDoc(doc(db(COGM), `${WA}/achievementDefs/ach-xy`), { title: 'editada' })));
  test('não tira Y de conquista compartilhada', () =>
    assertFails(updateDoc(doc(db(COGM), `${WA}/achievementDefs/ach-xy`), { campaignIds: ['X'] })));
  test('não exclui conquista compartilhada X+Y', () =>
    assertFails(deleteDoc(doc(db(COGM), `${WA}/achievementDefs/ach-xy`))));
  test('exclui conquista só de X', () =>
    assertSucceeds(deleteDoc(doc(db(COGM), `${WA}/achievementDefs/nova-x`))));
  test('não edita conquista global', () =>
    assertFails(updateDoc(doc(db(COGM), `${WA}/achievementDefs/ach-g`), { title: 'mexida' })));

  test('lista NPCs de X', () =>
    assertSucceeds(list(COGM, `${WA}/npcContacts`, where('campaignIds', 'array-contains', 'X'))));
  test('não lê NPC de Y', () => assertFails(get(COGM, `${WA}/npcContacts/npc-y`)));
  test('lista diálogos de X', () =>
    assertSucceeds(list(COGM, `${WA}/npcDialogues`, where('campaignIds', 'array-contains', 'X'))));

  test('lista mídia de X', async () => {
    const snap = await assertSucceeds(list(COGM, `${WA}/mediaAssets`, where('campaignId', '==', 'X')));
    if (snap.size !== 1) throw new Error(`esperado 1, veio ${snap.size}`);
  });
  test('não lê mídia da biblioteca sem campanha', () => assertFails(get(COGM, `${WA}/mediaAssets/m-lib`)));
  test('não lista mídia sem campanha', () =>
    assertFails(list(COGM, `${WA}/mediaAssets`, where('campaignId', '==', null))));
  test('não lê mídia de Y', () => assertFails(get(COGM, `${WA}/mediaAssets/m-y`)));
  test('sobe mídia em X', () =>
    assertSucceeds(setDoc(doc(db(COGM), `${WA}/mediaAssets/m-x2`), { campaignId: 'X' })));
  test('não move mídia de X para a biblioteca', () =>
    assertFails(updateDoc(doc(db(COGM), `${WA}/mediaAssets/m-x`), { campaignId: null })));
  test('lista pasta de mídia de X', () =>
    assertSucceeds(list(COGM, `${WA}/mediaFolders`, where('campaignId', '==', 'X'))));
  test('não cria pasta de mídia', () =>
    assertFails(setDoc(doc(db(COGM), `${WA}/mediaFolders/f-novo`), { campaignId: 'X' })));

  test('lista QR de X', () =>
    assertSucceeds(list(COGM, `${WA}/qrRedirects`, where('campaignId', '==', 'X'))));
  test('não lê QR de Y', () => assertFails(get(COGM, `${WA}/qrRedirects/qr-y`)));
  test('cria QR em X', () =>
    assertSucceeds(setDoc(doc(db(COGM), `${WA}/qrRedirects/qr-x2`), { campaignId: 'X', targetId: 'm-x' })));

  test('lista log de X', () =>
    assertSucceeds(list(COGM, `${WA}/activityLog`, where('campaignId', '==', 'X'))));
  test('não lista log sem filtro', () => assertFails(list(COGM, `${WA}/activityLog`)));
  test('grava log em X', () =>
    assertSucceeds(addDoc(collection(db(COGM), `${WA}/activityLog`), { campaignId: 'X', uid: COGM })));
  test('não grava log sem campanha', () =>
    assertFails(addDoc(collection(db(COGM), `${WA}/activityLog`), { campaignId: null, uid: COGM })));
  test('lista playEvents de X', () =>
    assertSucceeds(list(COGM, `${WA}/playEvents`, where('campaignId', '==', 'X'))));
  test('não lê estatísticas da pasta', () => assertFails(get(COGM, `${WA}/stats/analytics`)));
  test('não lê preferências da pasta', () => assertFails(get(COGM, `${WA}/config/settings`)));
  test('não anota jogador no roster', () =>
    assertFails(updateDoc(doc(db(COGM), `${WA}/players/${PLAYER}`), { notes: 'x' })));

  test('lista esquadrões de X', () =>
    assertSucceeds(list(COGM, `${WA}/groups`, where('campaignIds', 'array-contains', 'X'))));
  test('não lê esquadrão de Y', () => assertFails(get(COGM, `${WA}/groups/g-y`)));
  test('renomeia esquadrão de X', () =>
    assertSucceeds(updateDoc(doc(db(COGM), `${WA}/groups/g-x`), { name: 'Renomeado' })));
  test('não libera Y ao esquadrão de X por unlockedCampaigns', () =>
    assertFails(updateDoc(doc(db(COGM), `${WA}/groups/g-x`), { unlockedCampaigns: ['Y'] })));
  test('não troca a campanha ativa do esquadrão para Y', () =>
    assertFails(updateDoc(doc(db(COGM), `${WA}/groups/g-x`), { campaignId: 'Y' })));
  test('cria esquadrão em X', () =>
    assertSucceeds(setDoc(doc(db(COGM), `${WA}/groups/g-novo`), {
      name: 'Novo', campaignIds: ['X'], campaignId: 'X', unlockedCampaigns: [], characterSlots: [],
    })));
  test('não cria esquadrão com Y escondido em unlockedCampaigns', () =>
    assertFails(setDoc(doc(db(COGM), `${WA}/groups/g-novo2`), {
      name: 'Novo', campaignIds: ['X'], campaignId: 'X', unlockedCampaigns: ['Y'], characterSlots: [],
    })));
  test('lê mensagens do esquadrão de X', () => assertSucceeds(list(COGM, `${WA}/groups/g-x/messages`)));
  test('envia SMS ao esquadrão de X', () =>
    assertSucceeds(addDoc(collection(db(COGM), `${WA}/groups/g-x/messages`), { senderId: 'npc', text: 'oi', createdAt: 1 })));
  test('não lê mensagens do esquadrão de Y', () => assertFails(list(COGM, `${WA}/groups/g-y/messages`)));

  test('lista roster de X', () =>
    assertSucceeds(list(COGM, `${WA}/players`, where('campaignIds', 'array-contains', 'X'))));
  test('não lê jogador de Y', () => assertFails(get(COGM, `${WA}/players/${PLAYER_Y}`)));

  test('consulta agentes de X por collectionGroup', async () => {
    const snap = await assertSucceeds(getDocs(query(
      collectionGroup(db(COGM), 'characters'),
      where('workspaceId', '==', A),
      where('campaignId', '==', 'X'),
    )));
    if (snap.size !== 1) throw new Error(`esperado 1, veio ${snap.size}`);
  });
  test('não consulta todos os agentes da pasta', () =>
    assertFails(getDocs(query(collectionGroup(db(COGM), 'characters'), where('workspaceId', '==', A)))));
  test('lê agente de X e a intel dele', async () => {
    await assertSucceeds(get(COGM, `users/${PLAYER}/characters/chX`));
    await assertSucceeds(get(COGM, `users/${PLAYER}/characters/chX/intel/m-x`));
  });
  test('não lê agente de Y', () => assertFails(get(COGM, `users/${PLAYER_Y}/characters/chY`)));
  test('altera status do agente de X', () =>
    assertSucceeds(updateDoc(doc(db(COGM), `users/${PLAYER}/characters/chX`), { agentStatus: 'ferido' })));
  test('não libera campanha Y ao agente de X', () =>
    assertFails(updateDoc(doc(db(COGM), `users/${PLAYER}/characters/chX`), { unlockedCampaigns: ['X', 'Y'] })));
  test('não exclui agente', () => assertFails(deleteDoc(doc(db(COGM), `users/${PLAYER}/characters/chX`))));
  test('não consulta conquistas concedidas por collectionGroup', () =>
    assertFails(getDocs(query(collectionGroup(db(COGM), 'achievements'), where('workspaceId', '==', A)))));
  test('lê a trilha global da jukebox', () =>
    assertSucceeds(list(COGM, `${WA}/jukeboxTracks`, where('global', '==', true))));
});

describe('co-mestre suspenso', () => {
  test('não lê a campanha X', () => assertFails(get(SUSPENDED, `${WA}/campaigns/X`)));
  test('não lista mídia de X', () =>
    assertFails(list(SUSPENDED, `${WA}/mediaAssets`, where('campaignId', '==', 'X'))));
});

describe('jogador de A na campanha X', () => {
  test('lê a pasta (nome da mesa)', () => assertSucceeds(get(PLAYER, WA)));
  test('lê a campanha X e o estado', async () => {
    await assertSucceeds(get(PLAYER, `${WA}/campaigns/X`));
    await assertSucceeds(get(PLAYER, `${WA}/campaigns/X/state/live`));
  });
  test('não lê a campanha Y', () => assertFails(get(PLAYER, `${WA}/campaigns/Y`)));
  test('não grava o estado da campanha', () =>
    assertFails(setDoc(doc(db(PLAYER), `${WA}/campaigns/X/state/live`), { seized: true })));
  test('lista conquistas de X', () =>
    assertSucceeds(list(PLAYER, `${WA}/achievementDefs`, where('campaignIds', 'array-contains', 'X'))));
  test('lista conquistas globais', () =>
    assertSucceeds(list(PLAYER, `${WA}/achievementDefs`, where('global', '==', true))));
  test('não lista conquistas de Y', () =>
    assertFails(list(PLAYER, `${WA}/achievementDefs`, where('campaignIds', 'array-contains', 'Y'))));
  test('não lê a biblioteca de mídia', () =>
    assertFails(list(PLAYER, `${WA}/mediaAssets`, where('campaignId', '==', 'X'))));
  test('não lê NPCs', () =>
    assertFails(list(PLAYER, `${WA}/npcContacts`, where('campaignIds', 'array-contains', 'X'))));
  test('não lê QR', () => assertFails(get(PLAYER, `${WA}/qrRedirects/qr-x`)));
  test('lê o próprio esquadrão', () =>
    assertSucceeds(list(PLAYER, `${WA}/groups`, where('memberUids', 'array-contains', PLAYER))));
  test('não lê esquadrão alheio', () => assertFails(get(PLAYER, `${WA}/groups/g-y`)));
  test('lê e envia mensagem no próprio esquadrão', async () => {
    await assertSucceeds(list(PLAYER, `${WA}/groups/g-x/messages`));
    await assertSucceeds(addDoc(collection(db(PLAYER), `${WA}/groups/g-x/messages`), {
      senderId: 'chX', text: 'na escuta', createdAt: 1,
    }));
  });
  test('não envia mensagem como agente alheio', () =>
    assertFails(addDoc(collection(db(PLAYER), `${WA}/groups/g-x/messages`), {
      senderId: 'chY', text: 'falso', createdAt: 1,
    })));
  test('lê o próprio roster e o índice de pastas', async () => {
    await assertSucceeds(get(PLAYER, `${WA}/players/${PLAYER}`));
    await assertSucceeds(list(PLAYER, `users/${PLAYER}/memberships`));
  });
  test('não lista o roster', () => assertFails(list(PLAYER, `${WA}/players`)));
  test('não edita a própria anotação no roster', () =>
    assertFails(updateDoc(doc(db(PLAYER), `${WA}/players/${PLAYER}`), { notes: 'eu', gmLabel: 'eu' })));
  test('não lê nem grava preferências da pasta', async () => {
    await assertFails(get(PLAYER, `${WA}/config/settings`));
    await assertFails(setDoc(doc(db(PLAYER), `${WA}/config/settings`), { persistentItemIds: [] }));
  });
  test('não se dá campanhas pelo roster', () =>
    assertFails(updateDoc(doc(db(PLAYER), `${WA}/players/${PLAYER}`), { campaignIds: ['X', 'Y'] })));
  test('registra playEvent próprio', () =>
    assertSucceeds(addDoc(collection(db(PLAYER), `${WA}/playEvents`), { uid: PLAYER, campaignId: 'X', tapeId: 't' })));
  test('não registra playEvent em nome de outro', () =>
    assertFails(addDoc(collection(db(PLAYER), `${WA}/playEvents`), { uid: PLAYER_Y, campaignId: 'X' })));
  test('não registra playEvent em pasta onde não joga', () =>
    assertFails(addDoc(collection(db(PLAYER), `${WB}/playEvents`), { uid: PLAYER, campaignId: 'X' })));
  test('lê os próprios agentes e intel', async () => {
    await assertSucceeds(list(PLAYER, `users/${PLAYER}/characters`));
    await assertSucceeds(get(PLAYER, `users/${PLAYER}/characters/chX/intel/m-x`));
  });
  test('não grava intel no próprio agente', () =>
    assertFails(setDoc(doc(db(PLAYER), `users/${PLAYER}/characters/chX/intel/m-y`), { intelId: 'm-y' })));
  test('edita o codinome', () =>
    assertSucceeds(updateDoc(doc(db(PLAYER), `users/${PLAYER}/characters/chX`), { codinome: 'Novo' })));
  test('não muda o próprio nível de perigo', () =>
    assertFails(updateDoc(doc(db(PLAYER), `users/${PLAYER}/characters/chX`), { dangerLevel: 5 })));
  test('não troca a pasta do agente', () =>
    assertFails(updateDoc(doc(db(PLAYER), `users/${PLAYER}/characters/chX`), { workspaceId: B })));
  test('não se libera para outra campanha', () =>
    assertFails(updateDoc(doc(db(PLAYER), `users/${PLAYER}/characters/chX`), { unlockedCampaigns: ['X', 'Y'] })));
  test('cria outro agente na mesa onde joga', () =>
    assertSucceeds(setDoc(doc(db(PLAYER), `users/${PLAYER}/characters/chX2`), {
      codinome: 'Reserva', agentStatus: 'vivo', dangerLevel: 1, archived: false, workspaceId: A,
    })));
  test('não cria agente em mesa onde não joga', () =>
    assertFails(setDoc(doc(db(PLAYER), `users/${PLAYER}/characters/chZ`), {
      codinome: 'Intruso', agentStatus: 'vivo', dangerLevel: 1, archived: false, workspaceId: B,
    })));
  test('não cria agente já liberado em campanhas', () =>
    assertFails(setDoc(doc(db(PLAYER), `users/${PLAYER}/characters/chW`), {
      codinome: 'W', agentStatus: 'vivo', dangerLevel: 1, archived: false, workspaceId: A, unlockedCampaigns: ['Y'],
    })));
  test('edita o nome na própria conta', () =>
    assertSucceeds(updateDoc(doc(db(PLAYER), `users/${PLAYER}`), { displayName: 'Jogador' })));
  test('não se promove a admin pela conta', () =>
    assertFails(updateDoc(doc(db(PLAYER), `users/${PLAYER}`), { role: 'admin' })));
});

describe('admin da plataforma', () => {
  test('lê contas pessoais', () => assertSucceeds(get('platform', `users/${PLAYER}`)));
  test('lê estatísticas da plataforma', () => assertSucceeds(get('platform', 'platformStats/global')));
  test('não lê pasta alguma', () => assertFails(get('platform', WA)));
  test('não lista mídia de pasta', () => assertFails(list('platform', `${WA}/mediaAssets`)));
  test('não lê agentes', () => assertFails(get('platform', `users/${PLAYER}/characters/chX`)));
  test('não consulta agentes por collectionGroup', () =>
    assertFails(getDocs(query(collectionGroup(db('platform'), 'characters'), where('workspaceId', '==', A)))));
});

describe('legado', () => {
  test('role admin no Firestore não dá acesso', () =>
    assertFails(list('legacyRole', `${WA}/mediaAssets`)));
  test('role admin no Firestore não lê coleções antigas', () =>
    assertFails(get('legacyRole', 'mediaAssets/legacy1')));
  test('claim admin legado lê coleção antiga', () => assertSucceeds(get('legacy', 'mediaAssets/legacy1')));
  test('claim admin legado não escreve na coleção antiga', () =>
    assertFails(setDoc(doc(db('legacy'), 'mediaAssets/legacy2'), { x: 1 })));
  test('claim admin legado não lê pasta nova', () => assertFails(get('legacy', WA)));
  test('jogador não lê system antigo', () => assertFails(get(PLAYER, 'system/limboState')));
  test('anônimo não lê nada', () => assertFails(get('anon', `${WA}/campaigns/X`)));
});

describe('push: aparelhos, preferências e histórico', () => {
  const device = { token: 'tok', platform: 'ios', enabled: true, badge: 0 };
  const path = `users/${PLAYER}/devices/d1`;

  test('dono grava e lê o próprio aparelho', async () => {
    await assertSucceeds(setDoc(doc(db(PLAYER), path), device));
    await assertSucceeds(get(PLAYER, path));
  });
  test('mestre não lê aparelho do jogador', () => assertFails(get(A, path)));
  test('outra conta não grava aparelho', () =>
    assertFails(setDoc(doc(db(B), path), device)));
  test('cliente não soma badge', () =>
    assertFails(setDoc(doc(db(PLAYER), path), { ...device, badge: 5 })));
  test('campo fora da lista é recusado', () =>
    assertFails(setDoc(doc(db(PLAYER), path), { ...device, extra: 1 })));
  test('jogador grava as próprias preferências', () =>
    assertSucceeds(updateDoc(doc(db(PLAYER), `users/${PLAYER}`), { notificationPrefs: { intel: false } })));
  test('categoria desconhecida é recusada', () =>
    assertFails(updateDoc(doc(db(PLAYER), `users/${PLAYER}`), { notificationPrefs: { spam: true } })));
  test('mestre não grava preferências do jogador', () =>
    assertFails(updateDoc(doc(db(A), `users/${PLAYER}`), { notificationPrefs: { intel: false } })));
  test('jogador não marca notifyUid em mensagem do esquadrão', () =>
    assertFails(setDoc(doc(db(PLAYER), `${WA}/groups/g-x/messages/forjada`), {
      senderId: 'chX', text: 'oi', createdAt: serverTimestamp(), notifyUid: PLAYER_Y,
    })));
  test('histórico e lembretes não têm acesso direto', async () => {
    await assertFails(list(A, `${WA}/pushLog`));
    await assertFails(list(A, `${WA}/scheduledPushes`));
    await assertFails(setDoc(doc(db(A), `${WA}/scheduledPushes/s1`), { title: 'x' }));
  });
});
