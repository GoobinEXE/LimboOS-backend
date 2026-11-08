// Testes das Cloud Functions multi-tenant contra o emulador do Firestore.
// Rodar: cd backend/rules-tests && npm run test:functions
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-limboos-fn';
process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8085';

const { after, before, beforeEach, describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fft = require('firebase-functions-test')({ projectId: process.env.GCLOUD_PROJECT });
const fns = require('../index.js');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');

const db = getFirestore();
const A = 'ownerA';
const B = 'ownerB';
const COGM = 'cogmX';
const PLAYER = 'playerX';

function call(fn, uid, data, token = {}) {
  return fft.wrap(fn)({ data, auth: uid ? { uid, token } : undefined, rawRequest: {} });
}

async function expectCode(promise, code) {
  await assert.rejects(promise, (err) => {
    assert.equal(err.code, code, `esperado ${code}, veio ${err.code}: ${err.message}`);
    return true;
  });
}

async function clearDb() {
  const res = await fetch(
    `http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${process.env.GCLOUD_PROJECT}/databases/(default)/documents`,
    { method: 'DELETE' },
  );
  assert.ok(res.ok, 'falha ao limpar o emulador');
}

async function seed() {
  const put = (path, data) => db.doc(path).set(data);
  await put(`users/${A}`, { uid: A, masterName: 'mestreA' });
  await put(`users/${B}`, { uid: B, masterName: 'mestreB' });
  await put(`users/${COGM}`, { uid: COGM, masterName: 'cobertura' });
  await put(`users/${PLAYER}`, { uid: PLAYER, masterName: 'jogador' });
  await put('users/suspenso', { uid: 'suspenso', suspended: true });

  await put(`workspaces/${A}`, { ownerUid: A, name: 'Pasta A' });
  await put(`workspaces/${B}`, { ownerUid: B, name: 'Pasta B' });
  await put(`workspaces/${A}/campaigns/X`, { name: 'Campanha X' });
  await put(`workspaces/${A}/campaigns/Y`, { name: 'Campanha Y' });
  await put(`workspaces/${B}/campaigns/X`, { name: 'Campanha X de B' });
  await put(`workspaces/${A}/groups/g-x`, {
    name: 'Esquadrão X', campaignId: 'X', unlockedCampaigns: [], campaignIds: ['X'],
    characterSlots: [], memberUids: [],
  });

  await put(`workspaces/${A}/mediaAssets/m-x`, { campaignId: 'X', title: 'fita x' });
  await put(`workspaces/${A}/mediaAssets/m-y`, { campaignId: 'Y', title: 'fita y' });
  await put(`workspaces/${A}/mediaAssets/m-lib`, { campaignId: null, title: 'livre' });
  await put(`workspaces/${B}/mediaAssets/m-b`, { campaignId: 'X', title: 'fita de B' });
  await put(`workspaces/${A}/qrRedirects/QR-X`, { campaignId: 'X', targetId: 'm-x' });
  await put(`workspaces/${B}/qrRedirects/QR-B`, { campaignId: 'X', targetId: 'm-b' });
}

/** Coloca o jogador na mesa A, campanha X, via convite. */
async function joinPlayer() {
  const { token } = await call(fns.createInvite, A, { wsId: A, kind: 'player', campaignId: 'X', squadId: 'g-x' });
  const res = await call(fns.acceptInvite, PLAYER, { token, codinome: 'Agente X' });
  return res.characterId;
}

async function joinCoGm() {
  const { token } = await call(fns.createInvite, A, { wsId: A, kind: 'cogm', campaignId: 'X' });
  await call(fns.acceptInvite, COGM, { token });
}

beforeEach(async () => {
  await clearDb();
  await seed();
});

after(() => fft.cleanup());

describe('convites', () => {
  test('só o dono cria convite', async () => {
    await expectCode(call(fns.createInvite, COGM, { wsId: A, kind: 'cogm', campaignId: 'X' }), 'permission-denied');
    await expectCode(call(fns.createInvite, B, { wsId: A, kind: 'player', campaignId: 'X' }), 'permission-denied');
  });

  test('convite para campanha inexistente é recusado', async () => {
    await expectCode(call(fns.createInvite, A, { wsId: A, kind: 'cogm', campaignId: 'Z' }), 'not-found');
  });

  test('o token não fica gravado; só o hash', async () => {
    const { token, inviteId } = await call(fns.createInvite, A, { wsId: A, kind: 'cogm', campaignId: 'X' });
    const snap = await db.doc(`invites/${inviteId}`).get();
    assert.ok(snap.exists);
    assert.ok(!JSON.stringify(snap.data()).includes(token));
    const listed = await call(fns.listInvites, A, { wsId: A });
    assert.equal(listed.invites.length, 1);
    assert.ok(!JSON.stringify(listed).includes(token));
  });

  test('prévia mostra pasta e campanha', async () => {
    const { token } = await call(fns.createInvite, A, { wsId: A, kind: 'cogm', campaignId: 'X' });
    const preview = await call(fns.getInvitePreview, null, { token });
    assert.deepEqual(preview, { kind: 'cogm', workspaceName: 'Pasta A', campaignName: 'Campanha X', valid: true });
    const bad = await call(fns.getInvitePreview, null, { token: 'x'.repeat(22) });
    assert.equal(bad.valid, false);
  });

  test('co-mestre aceita e ganha acesso só a X', async () => {
    await joinCoGm();
    const member = (await db.doc(`workspaces/${A}/members/${COGM}`).get()).data();
    assert.deepEqual(member.campaignIds, ['X']);
    const membership = (await db.doc(`users/${COGM}/memberships/${A}`).get()).data();
    assert.deepEqual(membership.cogmCampaignIds, ['X']);
    assert.equal(membership.workspaceName, 'Pasta A');
  });

  test('convite de uso único não serve duas vezes', async () => {
    const { token } = await call(fns.createInvite, A, { wsId: A, kind: 'cogm', campaignId: 'X' });
    await call(fns.acceptInvite, COGM, { token });
    await expectCode(call(fns.acceptInvite, B, { token }), 'failed-precondition');
  });

  test('convite revogado e expirado são recusados', async () => {
    const r1 = await call(fns.createInvite, A, { wsId: A, kind: 'cogm', campaignId: 'X' });
    await call(fns.revokeInvite, A, { wsId: A, inviteId: r1.inviteId });
    await expectCode(call(fns.acceptInvite, COGM, { token: r1.token }), 'failed-precondition');

    const r2 = await call(fns.createInvite, A, { wsId: A, kind: 'cogm', campaignId: 'X' });
    await db.doc(`invites/${r2.inviteId}`).update({ expiresAt: Timestamp.fromMillis(Date.now() - 1000) });
    await expectCode(call(fns.acceptInvite, COGM, { token: r2.token }), 'failed-precondition');
  });

  test('outro dono não revoga convite da pasta A', async () => {
    const { inviteId } = await call(fns.createInvite, A, { wsId: A, kind: 'cogm', campaignId: 'X' });
    await expectCode(call(fns.revokeInvite, B, { wsId: A, inviteId }), 'permission-denied');
    await expectCode(call(fns.revokeInvite, B, { wsId: B, inviteId }), 'not-found');
  });

  test('dono não vira co-mestre da própria pasta', async () => {
    const { token } = await call(fns.createInvite, A, { wsId: A, kind: 'cogm', campaignId: 'X' });
    await expectCode(call(fns.acceptInvite, A, { token }), 'failed-precondition');
  });

  test('conta suspensa não aceita convite', async () => {
    const { token } = await call(fns.createInvite, A, { wsId: A, kind: 'player', campaignId: 'X' });
    await expectCode(call(fns.acceptInvite, 'suspenso', { token }), 'permission-denied');
  });

  test('jogador aceita: agente na mesa, roster e vaga no esquadrão', async () => {
    const characterId = await joinPlayer();
    const char = (await db.doc(`users/${PLAYER}/characters/${characterId}`).get()).data();
    assert.equal(char.workspaceId, A);
    assert.equal(char.campaignId, 'X');
    assert.deepEqual(char.unlockedCampaigns, ['X']);
    assert.equal(char.codinome, 'Agente X');
    const roster = (await db.doc(`workspaces/${A}/players/${PLAYER}`).get()).data();
    assert.deepEqual(roster.campaignIds, ['X']);
    assert.deepEqual(roster.characterIds, [characterId]);
    const group = (await db.doc(`workspaces/${A}/groups/g-x`).get()).data();
    assert.deepEqual(group.memberUids, [PLAYER]);
    assert.equal(group.characterSlots[0].characterId, characterId);
    const membership = (await db.doc(`users/${PLAYER}/memberships/${A}`).get()).data();
    assert.equal(membership.isPlayer, true);
  });

  test('segundo convite da mesma mesa reaproveita o agente', async () => {
    const first = await joinPlayer();
    const { token } = await call(fns.createInvite, A, { wsId: A, kind: 'player', campaignId: 'Y' });
    const res = await call(fns.acceptInvite, PLAYER, { token });
    assert.equal(res.characterId, first);
    const char = (await db.doc(`users/${PLAYER}/characters/${first}`).get()).data();
    assert.deepEqual([...char.unlockedCampaigns].sort(), ['X', 'Y']);
    assert.equal(char.campaignId, 'X');
  });

  test('remover co-mestre tira o acesso', async () => {
    await joinCoGm();
    await call(fns.removeCoGm, A, { wsId: A, uid: COGM, campaignId: 'X' });
    assert.equal((await db.doc(`workspaces/${A}/members/${COGM}`).get()).exists, false);
    const membership = (await db.doc(`users/${COGM}/memberships/${A}`).get()).data();
    assert.deepEqual(membership.cogmCampaignIds, []);
  });

  test('remover jogador arquiva o agente e libera a vaga', async () => {
    const characterId = await joinPlayer();
    await call(fns.removePlayer, A, { wsId: A, uid: PLAYER });
    assert.equal((await db.doc(`workspaces/${A}/players/${PLAYER}`).get()).exists, false);
    const char = (await db.doc(`users/${PLAYER}/characters/${characterId}`).get()).data();
    assert.equal(char.archived, true);
    const group = (await db.doc(`workspaces/${A}/groups/g-x`).get()).data();
    assert.deepEqual(group.characterSlots, []);
  });
});

describe('intel e QR com escopo de pasta', () => {
  test('jogador desbloqueia com QR da própria mesa', async () => {
    const characterId = await joinPlayer();
    await call(fns.unlockIntel, PLAYER, { characterId, intelId: 'm-x', sourceCode: 'QR-X' });
    const unlock = (await db.doc(`users/${PLAYER}/characters/${characterId}/intel/m-x`).get()).data();
    assert.equal(unlock.workspaceId, A);
    assert.equal(unlock.campaignId, 'X');
  });

  test('jogador não desbloqueia sem QR', async () => {
    const characterId = await joinPlayer();
    await expectCode(call(fns.unlockIntel, PLAYER, { characterId, intelId: 'm-x' }), 'permission-denied');
  });

  test('jogador não desbloqueia item de outra campanha', async () => {
    const characterId = await joinPlayer();
    await expectCode(
      call(fns.unlockIntel, PLAYER, { characterId, intelId: 'm-y', sourceCode: 'm-y' }),
      'permission-denied',
    );
  });

  test('QR e item de outra pasta não existem para o agente', async () => {
    const characterId = await joinPlayer();
    await expectCode(
      call(fns.unlockIntel, PLAYER, { characterId, intelId: 'm-b', sourceCode: 'QR-B' }),
      'not-found',
    );
    const resolved = await call(fns.resolveIntelCode, PLAYER, { code: 'QR-B', characterId });
    assert.equal(resolved.asset, null);
    const own = await call(fns.resolveIntelCode, PLAYER, { code: 'QR-X', characterId });
    assert.equal(own.asset.id, 'm-x');
  });

  test('outro mestre não entrega intel a agente da mesa A', async () => {
    const characterId = await joinPlayer();
    await expectCode(
      call(fns.unlockIntel, B, { characterId, intelId: 'm-x', targetUid: PLAYER }),
      'permission-denied',
    );
    await expectCode(
      call(fns.getMediaAssetsByIds, B, { characterId, assetIds: ['m-x'], targetUid: PLAYER }),
      'permission-denied',
    );
  });

  test('co-mestre entrega intel de X e não de Y', async () => {
    const characterId = await joinPlayer();
    await joinCoGm();
    await call(fns.unlockIntel, COGM, { characterId, intelId: 'm-x', targetUid: PLAYER });
    await expectCode(
      call(fns.unlockIntel, COGM, { characterId, intelId: 'm-y', targetUid: PLAYER }),
      'permission-denied',
    );
    await expectCode(
      call(fns.unlockIntel, COGM, { characterId, intelId: 'm-lib', targetUid: PLAYER }),
      'permission-denied',
    );
  });

  test('mídia por id: jogador recebe só o desbloqueado', async () => {
    const characterId = await joinPlayer();
    await call(fns.unlockIntel, PLAYER, { characterId, intelId: 'm-x', sourceCode: 'QR-X' });
    const res = await call(fns.getMediaAssetsByIds, PLAYER, { characterId, assetIds: ['m-x', 'm-y', 'm-b'] });
    assert.deepEqual(res.assets.map((a) => a.id), ['m-x']);
  });

  test('mestre consulta mídia da pasta sem agente', async () => {
    await joinCoGm();
    const owner = await call(fns.getMediaAssetsByIds, A, { wsId: A, assetIds: ['m-x', 'm-y', 'm-lib'] });
    assert.equal(owner.assets.length, 3);
    const cogm = await call(fns.getMediaAssetsByIds, COGM, { wsId: A, assetIds: ['m-x', 'm-y', 'm-lib'] });
    assert.deepEqual(cogm.assets.map((a) => a.id), ['m-x']);
    await expectCode(call(fns.getMediaAssetsByIds, B, { wsId: A, assetIds: ['m-x'] }), 'permission-denied');
  });

  test('conquista concedida grava a pasta e respeita a campanha', async () => {
    const characterId = await joinPlayer();
    await call(fns.grantAchievements, PLAYER, { characterId, achievementIds: ['ach1'], campaignId: 'X' });
    const doc = (await db.doc(`users/${PLAYER}/characters/${characterId}/achievements/ach1__X`).get()).data();
    assert.equal(doc.workspaceId, A);
    await expectCode(
      call(fns.grantAchievements, PLAYER, { characterId, achievementIds: ['ach2__Y'] }),
      'permission-denied',
    );
  });

  test('campanha ativa: só da mesa e liberada', async () => {
    const characterId = await joinPlayer();
    await expectCode(call(fns.setCharacterCampaign, PLAYER, { characterId, campaignId: 'Z' }), 'not-found');
    await expectCode(call(fns.setCharacterCampaign, PLAYER, { characterId, campaignId: 'Y' }), 'permission-denied');
    await call(fns.setCharacterCampaign, A, { characterId, campaignId: 'Y', targetUid: PLAYER });
    const char = (await db.doc(`users/${PLAYER}/characters/${characterId}`).get()).data();
    assert.equal(char.campaignId, 'Y');
  });
});

describe('agentes pelo dono', () => {
  test('cria agente extra só para jogador da mesa', async () => {
    await joinPlayer();
    const res = await call(fns.gmCreateCharacter, A, { wsId: A, uid: PLAYER, codinome: 'Reserva', campaignId: 'X' });
    const char = (await db.doc(`users/${PLAYER}/characters/${res.characterId}`).get()).data();
    assert.equal(char.workspaceId, A);
    assert.deepEqual(char.unlockedCampaigns, ['X']);
    await expectCode(call(fns.gmCreateCharacter, A, { wsId: A, uid: COGM, codinome: 'X' }), 'failed-precondition');
    await expectCode(call(fns.gmCreateCharacter, B, { wsId: A, uid: PLAYER, codinome: 'X' }), 'permission-denied');
  });

  test('transfere agente entre jogadores da mesma mesa', async () => {
    const characterId = await joinPlayer();
    await call(fns.unlockIntel, PLAYER, { characterId, intelId: 'm-x', sourceCode: 'QR-X' });
    const { token } = await call(fns.createInvite, A, { wsId: A, kind: 'player', campaignId: 'X' });
    await call(fns.acceptInvite, 'outro', { token, codinome: 'Outro' });
    await call(fns.transferCharacter, A, { wsId: A, fromUid: PLAYER, toUid: 'outro', characterId });
    assert.equal((await db.doc(`users/${PLAYER}/characters/${characterId}`).get()).exists, false);
    assert.equal((await db.doc(`users/outro/characters/${characterId}`).get()).data().workspaceId, A);
    assert.equal((await db.doc(`users/outro/characters/${characterId}/intel/m-x`).get()).exists, true);
    const group = (await db.doc(`workspaces/${A}/groups/g-x`).get()).data();
    assert.equal(group.characterSlots[0].uid, 'outro');
  });

  test('transferência para quem não joga na mesa é recusada', async () => {
    const characterId = await joinPlayer();
    await expectCode(
      call(fns.transferCharacter, A, { wsId: A, fromUid: PLAYER, toUid: COGM, characterId }),
      'failed-precondition',
    );
  });
});

describe('admin da plataforma', () => {
  test('callables de conta exigem o claim', async () => {
    await expectCode(call(fns.setAccountSuspended, A, { targetUid: PLAYER, suspended: true }), 'permission-denied');
    await expectCode(call(fns.adminResetPassword, A, { targetUid: PLAYER, newPassword: '123456' }), 'permission-denied');
    await expectCode(call(fns.adminCreateUser, A, { masterId: 'novo', password: '123456' }), 'permission-denied');
  });

  test('o claim não abre conteúdo de pasta nas Functions', async () => {
    await expectCode(
      call(fns.getMediaAssetsByIds, 'plat', { wsId: A, assetIds: ['m-x'] }, { platformAdmin: true }),
      'permission-denied',
    );
    await expectCode(
      call(fns.createInvite, 'plat', { wsId: A, kind: 'cogm', campaignId: 'X' }, { platformAdmin: true }),
      'permission-denied',
    );
  });
});

describe('triggers de consistência', () => {
  test('syncAccountToRosters copia nome e último acesso para o roster', async () => {
    await joinPlayer();
    const ref = db.doc(`users/${PLAYER}`);
    const before = await ref.get();
    await ref.set({ masterName: 'novoNome', lastLogin: Timestamp.now() }, { merge: true });
    const afterSnap = await ref.get();
    await fft.wrap(fns.syncAccountToRosters)({
      data: fft.makeChange(before, afterSnap),
      params: { uid: PLAYER },
    });
    const roster = (await db.doc(`workspaces/${A}/players/${PLAYER}`).get()).data();
    assert.equal(roster.masterName, 'novoNome');
    assert.ok(roster.lastLogin);
  });

  test('syncGroup deriva campaignIds e memberUids', async () => {
    const ref = db.doc(`workspaces/${A}/groups/g-sync`);
    const data = {
      name: 'S', campaignId: 'X', unlockedCampaigns: ['Y'],
      characterSlots: [{ uid: PLAYER, characterId: 'c1' }],
    };
    await ref.set(data);
    const beforeSnap = fft.firestore.makeDocumentSnapshot({}, `workspaces/${A}/groups/g-sync`);
    const afterSnap = await ref.get();
    await fft.wrap(fns.syncGroup)({
      data: fft.makeChange(beforeSnap, afterSnap),
      params: { wsId: A, groupId: 'g-sync' },
    });
    const saved = (await ref.get()).data();
    assert.deepEqual(saved.campaignIds, ['X', 'Y']);
    assert.deepEqual(saved.memberUids, [PLAYER]);
  });

  test('roster recalcula campanhas do agente e do esquadrão', async () => {
    const characterId = await joinPlayer();
    await db.doc(`workspaces/${A}/groups/g-x`).update({ unlockedCampaigns: ['Y'], campaignIds: ['X', 'Y'] });
    const groupSnap = await db.doc(`workspaces/${A}/groups/g-x`).get();
    await fft.wrap(fns.syncGroup)({
      data: fft.makeChange(groupSnap, groupSnap),
      params: { wsId: A, groupId: 'g-x' },
    });
    const roster = (await db.doc(`workspaces/${A}/players/${PLAYER}`).get()).data();
    assert.deepEqual(roster.campaignIds, ['X', 'Y']);
    assert.deepEqual(roster.characterIds, [characterId]);
  });
});

describe('agentes geridos pelo dono', () => {
  const OTHER = 'playerZ';

  async function joinOther() {
    await db.doc(`users/${OTHER}`).set({ uid: OTHER, masterName: 'outro' });
    const { token } = await call(fns.createInvite, A, { wsId: A, kind: 'player', campaignId: 'X' });
    return (await call(fns.acceptInvite, OTHER, { token, codinome: 'Agente Z' })).characterId;
  }

  test('gmCreateCharacter cria agente na pasta para jogador do roster', async () => {
    await joinPlayer();
    const res = await call(fns.gmCreateCharacter, A, { wsId: A, uid: PLAYER, codinome: ' Reserva ', campaignId: 'Y' });
    const ch = (await db.doc(`users/${PLAYER}/characters/${res.characterId}`).get()).data();
    assert.equal(ch.codinome, 'Reserva');
    assert.equal(ch.workspaceId, A);
    assert.equal(ch.campaignId, 'Y');
  });

  test('gmCreateCharacter recusa quem não é dono, quem não joga e campanha alheia', async () => {
    await joinPlayer();
    await expectCode(call(fns.gmCreateCharacter, B, { wsId: A, uid: PLAYER, codinome: 'x' }), 'permission-denied');
    await expectCode(call(fns.gmCreateCharacter, A, { wsId: A, uid: B, codinome: 'x' }), 'failed-precondition');
    await expectCode(
      call(fns.gmCreateCharacter, A, { wsId: A, uid: PLAYER, codinome: 'x', campaignId: 'nada' }),
      'not-found',
    );
    await expectCode(call(fns.gmCreateCharacter, A, { wsId: A, uid: PLAYER, codinome: '  ' }), 'invalid-argument');
  });

  test('transferCharacter move agente, progresso e vaga do esquadrão', async () => {
    const characterId = await joinPlayer();
    await joinOther();
    await db.doc(`users/${PLAYER}/characters/${characterId}/intel/i1`).set({ unlockedAt: 1 });
    await db.doc(`workspaces/${A}/groups/g-x`).set({
      characterSlots: [{ uid: PLAYER, characterId }], memberUids: [PLAYER],
    }, { merge: true });

    await call(fns.transferCharacter, A, { wsId: A, fromUid: PLAYER, toUid: OTHER, characterId });

    assert.equal((await db.doc(`users/${PLAYER}/characters/${characterId}`).get()).exists, false);
    assert.equal((await db.doc(`users/${PLAYER}/characters/${characterId}/intel/i1`).get()).exists, false);
    assert.equal((await db.doc(`users/${OTHER}/characters/${characterId}`).get()).data().workspaceId, A);
    assert.ok((await db.doc(`users/${OTHER}/characters/${characterId}/intel/i1`).get()).exists);
    const slots = (await db.doc(`workspaces/${A}/groups/g-x`).get()).data().characterSlots;
    assert.deepEqual(slots, [{ uid: OTHER, characterId }]);
    const roster = (await db.doc(`workspaces/${A}/players/${PLAYER}`).get()).data();
    assert.ok(!roster.characterIds.includes(characterId));
  });

  test('transferCharacter recusa destino fora da mesa, mesma conta e não dono', async () => {
    const characterId = await joinPlayer();
    await expectCode(
      call(fns.transferCharacter, A, { wsId: A, fromUid: PLAYER, toUid: B, characterId }),
      'failed-precondition',
    );
    await expectCode(
      call(fns.transferCharacter, A, { wsId: A, fromUid: PLAYER, toUid: PLAYER, characterId }),
      'invalid-argument',
    );
    await expectCode(
      call(fns.transferCharacter, B, { wsId: A, fromUid: PLAYER, toUid: B, characterId }),
      'permission-denied',
    );
  });
});
