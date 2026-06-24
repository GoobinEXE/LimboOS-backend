const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onDocumentCreated } = require('firebase-functions/v2/firestore');
const { initializeApp } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const functionsV1 = require('firebase-functions/v1');

initializeApp();

const REGION = 'southamerica-east1';

function masterIdToEmail(masterId) {
  const slug = masterId.trim().toLowerCase().replace(/[^a-z0-9._-]/g, '_');
  return `${slug}@limboos.local`;
}

function deriveMasterName(user) {
  if (user.displayName && user.displayName.trim()) {
    return user.displayName.trim();
  }
  const email = user.email || '';
  if (email.endsWith('@limboos.local')) {
    return email.replace('@limboos.local', '');
  }
  if (email.includes('@')) {
    return email.split('@')[0];
  }
  return null;
}

async function createUserProfileIfMissing(user) {
  const db = getFirestore();
  const email = user.email || '';
  const masterName = deriveMasterName(user);
  const userRef = db.doc(`users/${user.uid}`);
  const existing = await userRef.get();

  if (existing.exists) {
    return { created: false };
  }

  const profile = {
    uid: user.uid,
    email,
    role: 'player',
    createdAt: FieldValue.serverTimestamp(),
    lastLogin: FieldValue.serverTimestamp(),
  };

  if (masterName) {
    profile.masterName = masterName;
  }
  if (user.displayName) {
    profile.displayName = user.displayName;
  }

  await userRef.set(profile);
  return { created: true };
}

async function assertAdminAuth(request) {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Autenticação necessária.');
  }
  if (request.auth.token.admin === true) return;

  const db = getFirestore();
  const userDoc = await db.doc(`users/${request.auth.uid}`).get();
  if (!userDoc.exists || userDoc.data()?.role !== 'admin') {
    throw new HttpsError('permission-denied', 'Apenas o administrador pode executar esta operação.');
  }
}

/**
 * onAuthUserCreated — cria perfil Firestore de forma confiável para todo novo usuário Auth.
 */
exports.onAuthUserCreated = functionsV1
  .region(REGION)
  .auth.user()
  .onCreate(async (user) => {
    try {
      await createUserProfileIfMissing(user);
    } catch (err) {
      console.error('[onAuthUserCreated] Falha ao criar perfil:', user.uid, err);
      throw err;
    }
  });

/**
 * provisionUserProfile — cria perfil Firestore para contas Auth existentes sem users/{uid}.
 * Cobre login de contas antigas, falha do trigger onAuthUserCreated e race conditions.
 */
exports.provisionUserProfile = onCall({ region: REGION }, async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Autenticação necessária.');
  }

  try {
    const authUser = await getAuth().getUser(request.auth.uid);
    const result = await createUserProfileIfMissing(authUser);
    return { success: true, created: result.created };
  } catch (error) {
    console.error('[provisionUserProfile] Erro:', request.auth.uid, error);
    throw new HttpsError('internal', `Falha ao provisionar perfil: ${error.message}`);
  }
});

/**
 * adminCreateUser — cria conta Auth + perfil + personagem inicial via Admin SDK.
 */
exports.adminCreateUser = onCall({ region: REGION }, async (request) => {
  await assertAdminAuth(request);

  const { masterId, password, role = 'player' } = request.data || {};

  if (!masterId || typeof masterId !== 'string' || !masterId.trim()) {
    throw new HttpsError('invalid-argument', 'masterId é obrigatório.');
  }
  if (!password || typeof password !== 'string' || password.length < 6) {
    throw new HttpsError('invalid-argument', 'Senha deve ter no mínimo 6 caracteres.');
  }
  if (role !== 'player' && role !== 'admin') {
    throw new HttpsError('invalid-argument', 'role deve ser "player" ou "admin".');
  }

  const email = masterIdToEmail(masterId);
  const db = getFirestore();
  let createdUid = null;

  try {
    const authUser = await getAuth().createUser({ email, password });
    createdUid = authUser.uid;

    const charId = `${Date.now()}_${Math.random().toString(36).slice(2, 5)}`;

    await db.doc(`users/${createdUid}`).set({
      uid: createdUid,
      email,
      masterName: masterId.trim(),
      role,
      createdAt: FieldValue.serverTimestamp(),
      lastLogin: FieldValue.serverTimestamp(),
    }, { merge: true });

    await db.doc(`users/${createdUid}/characters/${charId}`).set({
      codinome: masterId.trim(),
      agentStatus: 'vivo',
      dangerLevel: 1,
      archived: false,
      createdAt: FieldValue.serverTimestamp(),
    });

    await db.collection('activityLog').add({
      uid: 'admin',
      username: request.auth.token.email || 'admin',
      type: 'admin',
      category: 'user_created',
      message: `Conta criada: ${masterId.trim()} (${createdUid.slice(0, 8)}...)`,
      metadata: { targetUid: createdUid, masterId: masterId.trim(), role },
      timestamp: new Date(),
      source: 'admin',
    });

    return { success: true, uid: createdUid, characterId: charId };
  } catch (error) {
    console.error('[adminCreateUser] Erro:', error);

    if (createdUid) {
      try {
        await getAuth().deleteUser(createdUid);
      } catch (deleteErr) {
        console.error('[adminCreateUser] Falha ao reverter Auth user:', createdUid, deleteErr);
      }
    }

    if (error instanceof HttpsError) throw error;
    throw new HttpsError('internal', `Falha ao criar usuário: ${error.message}`);
  }
});

/**
 * adminResetPassword — allows the admin to change any user's password.
 */
exports.adminResetPassword = onCall({ region: REGION }, async (request) => {
  await assertAdminAuth(request);

  const { targetUid, newPassword } = request.data;

  if (!targetUid || typeof targetUid !== 'string') {
    throw new HttpsError('invalid-argument', 'targetUid é obrigatório.');
  }
  if (!newPassword || typeof newPassword !== 'string' || newPassword.length < 6) {
    throw new HttpsError('invalid-argument', 'Senha deve ter no mínimo 6 caracteres.');
  }

  if (targetUid === request.auth.uid) {
    throw new HttpsError(
      'invalid-argument',
      'Use as configurações do seu perfil para alterar sua própria senha.',
    );
  }

  try {
    await getAuth().updateUser(targetUid, { password: newPassword });

    await getFirestore()
      .collection('activityLog')
      .add({
        uid: 'admin',
        username: 'gm.mpg',
        type: 'admin',
        category: 'password_reset',
        message: `Senha alterada para UID: ${targetUid.slice(0, 8)}...`,
        metadata: { targetUid },
        timestamp: new Date(),
        source: 'admin',
      });

    return { success: true };
  } catch (error) {
    console.error('Error resetting password:', error);
    throw new HttpsError('internal', `Falha ao alterar senha: ${error.message}`);
  }
});

/**
 * aggregatePlayEvent — Updates system/analytics when a new play event is recorded.
 */
exports.aggregatePlayEvent = onDocumentCreated(
  {
    document: 'playEvents/{eventId}',
    region: REGION,
  },
  async (event) => {
    const data = event.data.data();
    if (!data) return;

    const db = getFirestore();
    const analyticsRef = db.doc('system/analytics');

    const playedAt = data.playedAt ? data.playedAt.toDate() : new Date();
    const dateKey = playedAt.toISOString().slice(0, 10);
    const tapeId = data.tapeId || 'unknown';

    const updateData = {
      totalPlays: FieldValue.increment(1),
      [`dailyPlays.${dateKey}`]: FieldValue.increment(1),
      [`tapePlayCount.${tapeId}`]: FieldValue.increment(1),
      lastUpdatedAt: FieldValue.serverTimestamp(),
    };

    if (data.completed) {
      updateData.completedPlays = FieldValue.increment(1);
    }

    try {
      await analyticsRef.set(updateData, { merge: true });
    } catch (err) {
      console.error('Error updating analytics aggregation:', err);
    }
  },
);

/**
 * aggregateUserCreation — Updates total user count in system/analytics.
 */
exports.aggregateUserCreation = onDocumentCreated(
  {
    document: 'users/{userId}',
    region: REGION,
  },
  async (event) => {
    const db = getFirestore();
    const analyticsRef = db.doc('system/analytics');

    try {
      await analyticsRef.set(
        {
          totalUsers: FieldValue.increment(1),
          lastUpdatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
    } catch (err) {
      console.error('Error updating user count aggregation:', err);
    }
  },
);
