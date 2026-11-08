/**
 * Envio de notificações push por FCM. Os gatilhos e callables ficam em index.js;
 * aqui só há a entrega para uma conta: preferências, aparelhos e limpeza de tokens.
 *
 * O aparelho pertence à conta, que pode jogar em várias pastas; por isso o agente
 * e a pasta vão no payload, para o toque abrir o lugar certo.
 */
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getMessaging } = require('firebase-admin/messaging');

/** Mesmo id criado pelo app em src/services/PushService.ts. */
const ANDROID_CHANNEL_ID = 'limboos_transmissoes';

const DEAD_TOKEN_CODES = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
]);

let messagingFactory = getMessaging;

/** Os emuladores do Firebase não têm FCM; os testes injetam um envio falso. */
function setMessagingForTests(factory) {
  messagingFactory = factory || getMessaging;
}

/** FCM só aceita valores string em `data`. */
function toDataPayload(data) {
  const out = {};
  for (const [key, value] of Object.entries(data || {})) {
    if (value !== undefined && value !== null) out[key] = String(value);
  }
  return out;
}

function buildMessage(device, { title, body, category, data, collapseId }) {
  return {
    token: device.token,
    notification: { title, body },
    data: toDataPayload({ ...data, category }),
    android: {
      priority: 'high',
      ...(collapseId ? { collapseKey: collapseId } : {}),
      notification: {
        channelId: ANDROID_CHANNEL_ID,
        icon: 'ic_stat_limbo',
        color: '#FF8C00',
        ...(collapseId ? { tag: collapseId } : {}),
      },
    },
    apns: {
      ...(collapseId ? { headers: { 'apns-collapse-id': collapseId } } : {}),
      payload: { aps: { sound: 'default', badge: device.badge + 1 } },
    },
  };
}

/**
 * Envia para os aparelhos habilitados de uma conta, respeitando a preferência da
 * categoria. Conta suspensa não recebe nada.
 * Devolve { sent, failed, skipped }, com skipped em 'suspended', 'prefs' ou 'no-device'.
 */
async function sendToUser(uid, payload) {
  const db = getFirestore();
  const userSnap = await db.doc(`users/${uid}`).get();
  const user = userSnap.exists ? userSnap.data() || {} : {};
  if (user.suspended === true) return { sent: 0, failed: 0, skipped: 'suspended' };
  if (user.notificationPrefs?.[payload.category] === false) {
    return { sent: 0, failed: 0, skipped: 'prefs' };
  }

  const devicesSnap = await db.collection(`users/${uid}/devices`).where('enabled', '==', true).get();
  const devices = devicesSnap.docs
    .map((d) => ({
      ref: d.ref,
      token: d.data().token,
      badge: Number.isInteger(d.data().badge) ? d.data().badge : 0,
    }))
    .filter((d) => typeof d.token === 'string' && d.token.length > 0);
  if (devices.length === 0) return { sent: 0, failed: 0, skipped: 'no-device' };

  const response = await messagingFactory().sendEach(devices.map((d) => buildMessage(d, payload)));

  const batch = db.batch();
  response.responses.forEach((res, index) => {
    const device = devices[index];
    if (res.success) {
      batch.update(device.ref, { badge: FieldValue.increment(1) });
    } else if (DEAD_TOKEN_CODES.has(res.error?.code)) {
      batch.delete(device.ref);
    } else {
      console.warn('[push] falha de envio:', uid, res.error?.code);
    }
  });
  await batch.commit();

  return { sent: response.successCount, failed: response.failureCount, skipped: null };
}

/** Registro do envio na pasta; falha aqui nunca derruba a entrega. */
async function logPush(wsId, entry) {
  try {
    await getFirestore().collection(`workspaces/${wsId}/pushLog`).add({
      campaignId: null,
      createdBy: null,
      ...entry,
      createdAt: FieldValue.serverTimestamp(),
    });
  } catch (err) {
    console.error('[push] falha ao registrar:', wsId, err);
  }
}

module.exports = { sendToUser, logPush, setMessagingForTests, ANDROID_CHANNEL_ID };
