// Testa backend/scripts/migrate-to-workspaces.cjs contra o emulador do Firestore.
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-limboos-fn';
process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8085';

const { before, describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { initializeApp, getApps } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

if (!getApps().length) initializeApp({ projectId: process.env.GCLOUD_PROJECT });
const db = getFirestore();
const { main } = require('../../scripts/migrate-to-workspaces.cjs');

const OWNER = 'mestreLegado';

async function clearDb() {
  const res = await fetch(
    `http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${process.env.GCLOUD_PROJECT}/databases/(default)/documents`,
    { method: 'DELETE' },
  );
  assert.ok(res.ok);
}

async function seedLegacy() {
  const put = (p, d) => db.doc(p).set(d);
  await put(`users/${OWNER}`, { uid: OWNER, role: 'admin', masterName: 'gm' });
  await put('users/p1', { uid: 'p1', masterName: 'jogador1', hasTerminalAccess: true, notes: 'anotação' });
  await put('users/p1/characters/c1', { codinome: 'A1', campaignId: 'last-rewind', unlockedCampaigns: ['last-rewind'] });
  await put('users/p1/characters/c1/intel/tape1', { intelId: 'tape1', campaignId: 'last-rewind' });
  await put('users/p1/characters/c1/achievements/ACH-1__last-rewind', { achievementId: 'ACH-1', campaignId: 'last-rewind' });
  await put('users/p2', { uid: 'p2', masterName: 'jogador2' });
  await put('users/p2/characters/c2', { codinome: 'B2' });
  await put('campaigns/last-rewind', { name: 'LAST REWIND', status: 'Ativa' });
  await put('campaigns/side-b', { name: 'SIDE B', status: 'Ativa' });
  await put('groups/g1', {
    name: 'Esquadrão', campaignId: 'side-b', unlockedCampaigns: [],
    characterSlots: [{ uid: 'p2', characterId: 'c2' }],
  });
  await put('groups/g1/messages/m1', { senderId: 'npc', text: 'oi' });
  await put('mediaAssets/tape1', { type: 'audio', campaignId: 'last-rewind' });
  await put('mediaAssets/livre', { type: 'image' });
  await put('qrRedirects/QR1', { targetId: 'tape1' });
  await put('achievementDefs/ACH-1', { title: 'x', campaignIds: ['last-rewind'] });
  await put('achievementDefs/ACH-G', { title: 'g', campaignIds: 'global' });
  await put('playEvents/e1', { uid: 'p1', characterId: 'c1', tapeId: 'tape1' });
  await put('activityLog/l1', { type: 'admin', message: 'x' });
  await put('system/limboState', { seized: true, readThreadIds: ['t1'] });
  await put('system/gameEvents', { diskRepairAllowed: true });
  await put('system/campaignSettings', { persistentItemIds: ['tape1'] });
  await put('system/catalogState', { npcSms: { initialized: true } });
}

describe('migração para workspaces', () => {
  before(async () => {
    await clearDb();
    await seedLegacy();
  });

  test('simulação não grava nada', async () => {
    const res = await main([`--owner-uid=${OWNER}`]);
    assert.ok(res);
    assert.equal((await db.doc(`workspaces/${OWNER}`).get()).exists, false);
  });

  test('aplica e produz o modelo novo', async () => {
    await main([`--owner-uid=${OWNER}`, '--apply']);
    const W = (p) => db.doc(`workspaces/${OWNER}/${p}`);
    assert.equal((await db.doc(`workspaces/${OWNER}`).get()).data().ownerUid, OWNER);

    const camp = (await W('campaigns/last-rewind').get()).data();
    assert.equal(camp.features.diskRepair, true);
    const live = (await W('campaigns/side-b/state/live').get()).data();
    assert.equal(live.seized, true);
    assert.equal(live.diskRepairAllowed, true);
    assert.deepEqual((await W('config/settings').get()).data().persistentItemIds, ['tape1']);

    assert.equal((await W('mediaAssets/livre').get()).data().campaignId, null);
    assert.equal((await W('qrRedirects/QR1').get()).data().campaignId, 'last-rewind');
    const g = (await W('achievementDefs/ACH-G').get()).data();
    assert.deepEqual([g.global, g.campaignIds], [true, []]);
    const a1 = (await W('achievementDefs/ACH-1').get()).data();
    assert.deepEqual([a1.global, a1.campaignIds], [false, ['last-rewind']]);

    const group = (await W('groups/g1').get()).data();
    assert.deepEqual(group.memberUids, ['p2']);
    assert.deepEqual(group.campaignIds, ['side-b']);
    assert.equal((await W('groups/g1/messages/m1').get()).exists, true);

    const c1 = (await db.doc('users/p1/characters/c1').get()).data();
    assert.equal(c1.workspaceId, OWNER);
    assert.equal(c1.hasTerminalAccess, true);
    assert.equal((await db.doc('users/p1/characters/c1/intel/tape1').get()).data().workspaceId, OWNER);
    assert.equal(
      (await db.doc('users/p1/characters/c1/achievements/ACH-1__last-rewind').get()).data().workspaceId,
      OWNER,
    );

    const r1 = (await W('players/p1').get()).data();
    assert.deepEqual(r1.campaignIds, ['last-rewind']);
    assert.equal(r1.notes, 'anotação');
    const r2 = (await W('players/p2').get()).data();
    assert.deepEqual(r2.campaignIds, ['side-b']);
    assert.equal((await db.doc(`users/p2/memberships/${OWNER}`).get()).data().isPlayer, true);

    assert.equal((await W('playEvents/e1').get()).data().campaignId, 'last-rewind');
    assert.equal((await W('activityLog/l1').get()).exists, true);
  });

  test('rodar de novo não duplica e mantém o resultado', async () => {
    await main([`--owner-uid=${OWNER}`, '--apply']);
    const players = await db.collection(`workspaces/${OWNER}/players`).get();
    assert.equal(players.size, 2);
  });

  test('rodar de novo não puxa agente de outra pasta', async () => {
    await db.doc('users/p3').set({ uid: 'p3', masterName: 'de outra mesa' });
    await db.doc('users/p3/characters/c3').set({ codinome: 'C3', workspaceId: 'outraPasta' });
    await db.doc('users/p3/characters/c3/intel/x').set({ intelId: 'x', workspaceId: 'outraPasta' });
    const res = await main([`--owner-uid=${OWNER}`, '--apply']);
    assert.equal(res.counts.skippedForeignCharacters, 1);
    assert.equal((await db.doc('users/p3/characters/c3').get()).data().workspaceId, 'outraPasta');
    assert.equal((await db.doc('users/p3/characters/c3/intel/x').get()).data().workspaceId, 'outraPasta');
    assert.equal((await db.doc(`workspaces/${OWNER}/players/p3`).get()).exists, false);
    assert.equal((await db.doc(`users/p3/memberships/${OWNER}`).get()).exists, false);
  });
});
