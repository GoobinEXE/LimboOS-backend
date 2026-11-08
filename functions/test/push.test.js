// Testes do envio de push contra o emulador do Firestore, com FCM falso.
// Rodar: cd backend/rules-tests && npm run test:functions
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-limboos-fn';
process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8085';

const { after, beforeEach, describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fft = require('firebase-functions-test')({ projectId: process.env.GCLOUD_PROJECT });
const fns = require('../index.js');
const push = require('../push.js');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');

const db = getFirestore();
const A = 'ownerA';
const B = 'ownerB';
const COGM = 'cogmX';
const P1 = 'player1';
const P2 = 'player2';

let sentMessages = [];
let failToken = null;

push.setMessagingForTests(() => ({
  sendEach: async (messages) => {
    sentMessages.push(...messages);
    const responses = messages.map((m) => (m.token === failToken
      ? { success: false, error: { code: 'messaging/registration-token-not-registered' } }
      : { success: true }));
    return {
      responses,
      successCount: responses.filter((r) => r.success).length,
      failureCount: responses.filter((r) => !r.success).length,
    };
  },
}));

function call(fn, uid, data) {
  return fft.wrap(fn)({ data, auth: { uid, token: {} }, rawRequest: {} });
}

async function expectCode(promise, code) {
  await assert.rejects(promise, (err) => {
    assert.equal(err.code, code, `esperado ${code}, veio ${err.code}: ${err.message}`);
    return true;
  });
}

async function fire(fn, path, params) {
  await fft.wrap(fn)({ data: await db.doc(path).get(), params });
}

async function seed() {
  const res = await fetch(
    `http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${process.env.GCLOUD_PROJECT}/databases/(default)/documents`,
    { method: 'DELETE' },
  );
  assert.ok(res.ok);
  const put = (path, data) => db.doc(path).set(data);
  await Promise.all([
    put(`users/${A}`, { uid: A }),
    put(`users/${B}`, { uid: B }),
    put(`users/${COGM}`, { uid: COGM }),
    put(`users/${P1}`, { uid: P1 }),
    put(`users/${P2}`, { uid: P2 }),
    put(`users/${P1}/devices/d1`, { token: 'tok-1', platform: 'ios', enabled: true, badge: 2 }),
    put(`users/${P1}/devices/off`, { token: 'tok-off', platform: 'ios', enabled: false }),
    put(`users/${P2}/devices/d2`, { token: 'tok-2', platform: 'android', enabled: true }),
    put(`users/${P1}/characters/c1`, { codinome: 'Corvo', workspaceId: A, campaignId: 'X' }),
    put(`users/${P2}/characters/c2`, { codinome: 'Lince', workspaceId: A, campaignId: 'Y' }),
    put(`users/${P2}/characters/cB`, { codinome: 'Outra', workspaceId: B, campaignId: 'X' }),
    put(`workspaces/${A}/members/${COGM}`, { campaignIds: ['X'] }),
    put(`workspaces/${A}/players/${P1}`, { campaignIds: ['X'], characterIds: ['c1'] }),
    put(`workspaces/${A}/players/${P2}`, { campaignIds: ['Y'], characterIds: ['c2'] }),
    put(`workspaces/${A}/groups/gx`, {
      name: 'Esquadrão', campaignId: 'X', campaignIds: ['X'],
      characterSlots: [{ uid: P1, characterId: 'c1' }],
    }),
    put(`workspaces/${A}/groups/gy`, {
      name: 'Outro', campaignId: 'Y', campaignIds: ['Y'],
      characterSlots: [{ uid: P2, characterId: 'c2' }],
    }),
  ]);
}

beforeEach(async () => {
  sentMessages = [];
  failToken = null;
  await seed();
});

after(() => {
  push.setMessagingForTests(null);
  fft.cleanup();
});

describe('entregas automáticas', () => {
  const intelPath = `users/${P1}/characters/c1/intel/m1`;
  const intelParams = { uid: P1, characterId: 'c1', intelId: 'm1' };

  test('intel do mestre notifica sem citar o item e soma o badge', async () => {
    await db.doc(intelPath).set({ intelId: 'm1', type: 'AUDIO', workspaceId: A, source: 'admin' });
    await fire(fns.pushOnIntelGranted, intelPath, intelParams);
    assert.equal(sentMessages.length, 1);
    const [msg] = sentMessages;
    assert.equal(msg.token, 'tok-1');
    assert.equal(msg.apns.payload.aps.badge, 3);
    assert.match(msg.notification.body, /^Corvo: novo arquivo de áudio/);
    assert.deepEqual(
      { characterId: msg.data.characterId, wsId: msg.data.wsId, category: msg.data.category },
      { characterId: 'c1', wsId: A, category: 'intel' },
    );
    assert.equal((await db.doc(`users/${P1}/devices/d1`).get()).data().badge, 3);
    const log = await db.collection(`workspaces/${A}/pushLog`).get();
    assert.equal(log.size, 1);
    assert.equal(log.docs[0].data().sent, 1);
  });

  test('desbloqueio do próprio jogador não notifica', async () => {
    await db.doc(intelPath).set({ intelId: 'm1', workspaceId: A, source: 'player' });
    await fire(fns.pushOnIntelGranted, intelPath, intelParams);
    assert.equal(sentMessages.length, 0);
  });

  test('preferência desligada bloqueia a categoria', async () => {
    await db.doc(`users/${P1}`).set({ notificationPrefs: { intel: false } }, { merge: true });
    await db.doc(intelPath).set({ intelId: 'm1', workspaceId: A, source: 'admin' });
    await fire(fns.pushOnIntelGranted, intelPath, intelParams);
    assert.equal(sentMessages.length, 0);
    assert.equal((await db.collection(`workspaces/${A}/pushLog`).get()).docs[0].data().skipped, 'prefs');
  });

  test('conta suspensa não recebe', async () => {
    await db.doc(`users/${P1}`).set({ suspended: true }, { merge: true });
    await db.doc(intelPath).set({ intelId: 'm1', workspaceId: A, source: 'admin' });
    await fire(fns.pushOnIntelGranted, intelPath, intelParams);
    assert.equal(sentMessages.length, 0);
  });

  test('workspaceId que não é o do agente não notifica', async () => {
    await db.doc(intelPath).set({ intelId: 'm1', workspaceId: B, source: 'admin' });
    await fire(fns.pushOnIntelGranted, intelPath, intelParams);
    assert.equal(sentMessages.length, 0);
  });

  test('token morto é apagado', async () => {
    failToken = 'tok-1';
    await db.doc(intelPath).set({ intelId: 'm1', workspaceId: A, source: 'admin' });
    await fire(fns.pushOnIntelGranted, intelPath, intelParams);
    assert.equal((await db.doc(`users/${P1}/devices/d1`).get()).exists, false);
  });

  test('conquista do mestre notifica', async () => {
    const path = `users/${P1}/characters/c1/achievements/a1__X`;
    await db.doc(path).set({ achievementId: 'a1', workspaceId: A, source: 'admin' });
    await fire(fns.pushOnAchievementGranted, path, { uid: P1, characterId: 'c1', achievementId: 'a1__X' });
    assert.equal(sentMessages[0].data.achievementId, 'a1');
  });

  test('vídeo sem intel notifica uma vez por transmissão', async () => {
    const path = `users/${P1}/characters/c1`;
    const params = { uid: P1, characterId: 'c1' };
    const video = (notify, requestId) => ({
      codinome: 'Corvo', workspaceId: A, campaignId: 'X', pendingVideoPlay: { intelId: 'v1', requestId, notify },
    });
    const run = async (before, after) => {
      await db.doc(path).set(after);
      const afterSnap = await db.doc(path).get();
      await fft.wrap(fns.pushOnVideoBroadcast)({
        data: fft.makeChange(fft.firestore.makeDocumentSnapshot(before, path), afterSnap),
        params,
      });
    };
    const idle = { codinome: 'Corvo', workspaceId: A, campaignId: 'X' };
    await run(idle, video(false, 'r0'));
    assert.equal(sentMessages.length, 0);
    await run(idle, video(true, 'r1'));
    assert.equal(sentMessages.length, 1);
    assert.equal(sentMessages[0].data.intelId, 'v1');
    await run(video(true, 'r1'), video(true, 'r1'));
    assert.equal(sentMessages.length, 1);
  });

  test('SMS só notifica a mensagem marcada', async () => {
    const params = { wsId: A, groupId: 'gx', messageId: 'm' };
    const path = `workspaces/${A}/groups/gx/messages/m`;
    await db.doc(path).set({ npcId: 'n1', recipientId: 'c1', text: 'oi' });
    await fire(fns.pushOnNpcMessage, path, params);
    assert.equal(sentMessages.length, 0);
    await db.doc(path).set({ npcId: 'n1', recipientId: 'c1', notifyUid: P1, text: 'oi' });
    await fire(fns.pushOnNpcMessage, path, params);
    assert.equal(sentMessages.length, 1);
  });

  test('SMS de outra pasta não alcança conta alheia', async () => {
    const path = `workspaces/${B}/groups/g/messages/m`;
    await db.doc(path).set({ npcId: 'n1', recipientId: 'c1', notifyUid: P1, text: 'oi' });
    await fire(fns.pushOnNpcMessage, path, { wsId: B, groupId: 'g', messageId: 'm' });
    assert.equal(sentMessages.length, 0);
  });
});

describe('push manual', () => {
  const msg = { title: 'Sessão', body: 'Hoje às 20h' };

  test('dono envia para a pasta inteira', async () => {
    const res = await call(fns.adminSendPush, A, { wsId: A, target: { kind: 'all' }, ...msg });
    assert.equal(res.sent, 2);
  });

  test('campanha leva o agente daquela campanha no payload', async () => {
    await call(fns.adminSendPush, A, { wsId: A, target: { kind: 'campaign', campaignId: 'Y' }, ...msg });
    assert.equal(sentMessages.length, 1);
    assert.equal(sentMessages[0].data.characterId, 'c2');
    assert.equal(sentMessages[0].data.category, 'gm');
  });

  test('co-mestre só alcança as próprias campanhas', async () => {
    const res = await call(fns.adminSendPush, COGM, { wsId: A, target: { kind: 'group', groupId: 'gx' }, ...msg });
    assert.equal(res.sent, 1);
    await expectCode(call(fns.adminSendPush, COGM, { wsId: A, target: { kind: 'all' }, ...msg }), 'permission-denied');
    await expectCode(call(fns.adminSendPush, COGM, { wsId: A, target: { kind: 'group', groupId: 'gy' }, ...msg }), 'permission-denied');
    await expectCode(call(fns.adminSendPush, COGM, { wsId: A, target: { kind: 'campaign', campaignId: 'Y' }, ...msg }), 'permission-denied');
    await expectCode(call(fns.adminSendPush, COGM, {
      wsId: A, target: { kind: 'characters', items: [{ uid: P2, characterId: 'c2' }] }, ...msg,
    }), 'permission-denied');
  });

  test('lista de agentes manda um aviso por conta com o agente certo', async () => {
    const res = await call(fns.adminSendPush, A, {
      wsId: A,
      target: { kind: 'characters', items: [{ uid: P1, characterId: 'c1' }, { uid: P2, characterId: 'c2' }] },
      ...msg,
    });
    assert.equal(res.sent, 2);
    assert.deepEqual(sentMessages.map((m) => m.data.characterId).sort(), ['c1', 'c2']);
  });

  test('outro mestre e jogador são recusados', async () => {
    await expectCode(call(fns.adminSendPush, B, { wsId: A, target: { kind: 'all' }, ...msg }), 'permission-denied');
    await expectCode(call(fns.adminSendPush, P1, { wsId: A, target: { kind: 'all' }, ...msg }), 'permission-denied');
  });

  test('agente de outra pasta não é alvo', async () => {
    await expectCode(call(fns.adminSendPush, A, {
      wsId: A, target: { kind: 'characters', items: [{ uid: P2, characterId: 'cB' }] }, ...msg,
    }), 'not-found');
  });

  test('texto vazio ou longo é recusado', async () => {
    await expectCode(call(fns.adminSendPush, A, { wsId: A, target: { kind: 'all' }, title: ' ', body: 'x' }), 'invalid-argument');
    await expectCode(call(fns.adminSendPush, A, { wsId: A, target: { kind: 'all' }, title: 'x', body: 'y'.repeat(241) }), 'invalid-argument');
  });

  test('histórico respeita a campanha do co-mestre', async () => {
    await call(fns.adminSendPush, A, { wsId: A, target: { kind: 'campaign', campaignId: 'X' }, ...msg });
    await call(fns.adminSendPush, A, { wsId: A, target: { kind: 'campaign', campaignId: 'Y' }, ...msg });
    assert.equal((await call(fns.listPushActivity, A, { wsId: A })).log.length, 2);
    assert.equal((await call(fns.listPushActivity, COGM, { wsId: A })).log.length, 1);
  });
});

describe('lembretes', () => {
  const msg = { title: 'Lembrete', body: 'Sessão hoje' };
  const soon = () => new Date(Date.now() + 3_600_000).toISOString();

  async function makeDue(id) {
    await db.doc(`workspaces/${A}/scheduledPushes/${id}`).update({ sendAt: Timestamp.fromMillis(Date.now() - 1000) });
  }

  test('agenda, envia uma vez só e marca enviado', async () => {
    const { id } = await call(fns.schedulePush, A, { wsId: A, target: { kind: 'all' }, sendAt: soon(), ...msg });
    await fns.dispatchScheduledPushes.run({});
    assert.equal(sentMessages.length, 0);
    await makeDue(id);
    await fns.dispatchScheduledPushes.run({});
    assert.equal(sentMessages.length, 2);
    assert.equal(sentMessages[0].data.category, 'reminders');
    assert.equal((await db.doc(`workspaces/${A}/scheduledPushes/${id}`).get()).data().status, 'sent');
    await fns.dispatchScheduledPushes.run({});
    assert.equal(sentMessages.length, 2);
  });

  test('co-mestre removido antes do envio falha sem enviar', async () => {
    const { id } = await call(fns.schedulePush, COGM, { wsId: A, target: { kind: 'group', groupId: 'gx' }, sendAt: soon(), ...msg });
    await db.doc(`workspaces/${A}/members/${COGM}`).delete();
    await makeDue(id);
    await fns.dispatchScheduledPushes.run({});
    assert.equal(sentMessages.length, 0);
    assert.equal((await db.doc(`workspaces/${A}/scheduledPushes/${id}`).get()).data().status, 'failed');
  });

  test('data no passado é recusada', async () => {
    await expectCode(call(fns.schedulePush, A, {
      wsId: A, target: { kind: 'all' }, sendAt: new Date(Date.now() - 3_600_000).toISOString(), ...msg,
    }), 'invalid-argument');
  });

  test('cancelamento segue o escopo do co-mestre', async () => {
    const { id } = await call(fns.schedulePush, A, { wsId: A, target: { kind: 'campaign', campaignId: 'Y' }, sendAt: soon(), ...msg });
    await expectCode(call(fns.cancelScheduledPush, COGM, { wsId: A, id }), 'permission-denied');
    await call(fns.cancelScheduledPush, A, { wsId: A, id });
    await makeDue(id);
    await fns.dispatchScheduledPushes.run({});
    assert.equal(sentMessages.length, 0);
  });
});
