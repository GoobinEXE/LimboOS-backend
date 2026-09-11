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

async function assertActiveAuth(request) {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Autenticação necessária.');
  }
  const db = getFirestore();
  const userDoc = await db.doc(`users/${request.auth.uid}`).get();
  if (userDoc.exists) {
    const data = userDoc.data() || {};
    if (data.suspended === true && data.role !== 'admin' && request.auth.token.admin !== true) {
      throw new HttpsError('permission-denied', 'Conta suspensa.');
    }
  }
  return userDoc;
}

async function assertOwnsCharacter(uid, characterId) {
  const db = getFirestore();
  const charRef = db.doc(`users/${uid}/characters/${characterId}`);
  const charSnap = await charRef.get();
  if (!charSnap.exists) {
    throw new HttpsError('not-found', 'Personagem não encontrado.');
  }
  return charSnap;
}

async function isRequestAdmin(request) {
  if (request.auth?.token?.admin === true) return true;
  const db = getFirestore();
  const userDoc = await db.doc(`users/${request.auth.uid}`).get();
  return userDoc.exists && userDoc.data()?.role === 'admin';
}

/**
 * unlockIntel — desbloqueia intel para o próprio personagem (ou qualquer, se admin).
 * Não-admin + mediaAsset remoto: exige QR (sourceCode / qrRedirects) ou unlock prévio.
 */
exports.unlockIntel = onCall({ region: REGION }, async (request) => {
  await assertActiveAuth(request);

  const { characterId, intelId, campaignId, targetUid, sourceCode } = request.data || {};
  if (!characterId || typeof characterId !== 'string') {
    throw new HttpsError('invalid-argument', 'characterId é obrigatório.');
  }
  if (!intelId || typeof intelId !== 'string' || intelId.length > 128) {
    throw new HttpsError('invalid-argument', 'intelId inválido.');
  }

  const admin = await isRequestAdmin(request);
  const uid = admin && typeof targetUid === 'string' && targetUid
    ? targetUid
    : request.auth.uid;

  if (!admin && uid !== request.auth.uid) {
    throw new HttpsError('permission-denied', 'Sem permissão para este personagem.');
  }

  await assertOwnsCharacter(uid, characterId);

  const db = getFirestore();
  const intelRef = db.doc(`users/${uid}/characters/${characterId}/intel/${intelId}`);
  const existingUnlock = await intelRef.get();

  if (!admin && !existingUnlock.exists) {
    const assetSnap = await db.doc(`mediaAssets/${intelId}`).get();
    if (assetSnap.exists) {
      const codesToTry = [];
      if (typeof sourceCode === 'string' && sourceCode) codesToTry.push(sourceCode);
      codesToTry.push(intelId);

      let qrAuthorized = false;
      for (const code of codesToTry) {
        const redirectSnap = await db.doc(`qrRedirects/${code}`).get();
        if (!redirectSnap.exists) continue;
        const targetId = redirectSnap.data()?.targetId || code;
        if (targetId === intelId) {
          qrAuthorized = true;
          break;
        }
      }

      if (!qrAuthorized) {
        throw new HttpsError(
          'permission-denied',
          'Desbloqueio de mídia remota requer código QR válido.',
        );
      }
    }
    // Sem mediaAsset: intel local/hardcoded — permitido (já no client bundle)
  }

  await intelRef.set(
    {
      intelId,
      unlockedAt: FieldValue.serverTimestamp(),
      campaignId: campaignId || null,
      type: 'AUDIO',
    },
    { merge: true },
  );

  return { success: true, intelId };
});

/**
 * grantAchievements — concede conquistas ao próprio personagem (ou qualquer, se admin).
 */
exports.grantAchievements = onCall({ region: REGION }, async (request) => {
  await assertActiveAuth(request);

  const { characterId, achievementIds, targetUid, campaignId, platform } = request.data || {};
  if (!characterId || typeof characterId !== 'string') {
    throw new HttpsError('invalid-argument', 'characterId é obrigatório.');
  }
  if (!Array.isArray(achievementIds) || achievementIds.length === 0 || achievementIds.length > 50) {
    throw new HttpsError('invalid-argument', 'achievementIds inválido.');
  }

  const admin = await isRequestAdmin(request);
  const uid = admin && typeof targetUid === 'string' && targetUid
    ? targetUid
    : request.auth.uid;

  if (!admin && uid !== request.auth.uid) {
    throw new HttpsError('permission-denied', 'Sem permissão para este personagem.');
  }

  await assertOwnsCharacter(uid, characterId);

  const resolvedCampaign =
    typeof campaignId === 'string' && campaignId.length > 0 && campaignId.length <= 128
      ? campaignId
      : 'unscoped';
  const resolvedPlatform =
    platform === 'nokia' || platform === 'walkman' || platform === 'global'
      ? platform
      : 'walkman';

  const db = getFirestore();
  const batch = db.batch();
  for (const id of achievementIds) {
    if (typeof id !== 'string' || !id || id.length > 128) {
      throw new HttpsError('invalid-argument', 'achievementId inválido.');
    }
    // Aceita id base ou doc composto já montado
    const isComposite = id.includes('__');
    const docId = isComposite ? id : `${id}__${resolvedCampaign}`;
    const baseId = isComposite ? id.slice(0, id.lastIndexOf('__')) : id;
    const campFromDoc = isComposite ? id.slice(id.lastIndexOf('__') + 2) : resolvedCampaign;
    const ref = db.doc(`users/${uid}/characters/${characterId}/achievements/${docId}`);
    batch.set(ref, {
      achievementId: baseId,
      campaignId: campFromDoc,
      platform: resolvedPlatform,
      unlockedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
  }
  await batch.commit();

  return { success: true, count: achievementIds.length };
});

/**
 * resolveIntelCode — resolve QR/código para um asset (sem listar o catálogo).
 * Não-admin: só resolve se existir qrRedirects/{code} (bloqueia enumeração por assetId).
 */
exports.resolveIntelCode = onCall({ region: REGION }, async (request) => {
  await assertActiveAuth(request);

  const { code } = request.data || {};
  if (!code || typeof code !== 'string' || code.length > 128) {
    throw new HttpsError('invalid-argument', 'code inválido.');
  }

  const db = getFirestore();
  const admin = await isRequestAdmin(request);
  const redirectSnap = await db.doc(`qrRedirects/${code}`).get();

  if (!admin && !redirectSnap.exists) {
    // Bloqueia resolve direto por ID de mediaAsset (enumeração do acervo)
    return { success: true, redirectedId: null, asset: null };
  }

  const finalCode = redirectSnap.exists
    ? (redirectSnap.data()?.targetId || code)
    : code;

  if (!finalCode || typeof finalCode !== 'string') {
    return { success: true, redirectedId: null, asset: null };
  }

  const assetSnap = await db.doc(`mediaAssets/${finalCode}`).get();
  if (!assetSnap.exists) {
    return { success: true, redirectedId: redirectSnap.exists ? finalCode : null, asset: null };
  }

  const data = assetSnap.data() || {};
  // Metadados mínimos + URL só após caminho QR (ou admin) — necessário para playback imediato pós-scan
  return {
    success: true,
    redirectedId: redirectSnap.exists ? finalCode : null,
    asset: {
      id: assetSnap.id,
      ...data,
      _viaQr: redirectSnap.exists,
    },
  };
});

/**
 * getMediaAssetsByIds — retorna mediaAssets apenas se desbloqueados para o personagem (ou admin).
 */
exports.getMediaAssetsByIds = onCall({ region: REGION }, async (request) => {
  await assertActiveAuth(request);

  const { characterId, assetIds, targetUid } = request.data || {};
  if (!Array.isArray(assetIds) || assetIds.length === 0 || assetIds.length > 50) {
    throw new HttpsError('invalid-argument', 'assetIds inválido.');
  }

  const admin = await isRequestAdmin(request);
  const uid = admin && typeof targetUid === 'string' && targetUid
    ? targetUid
    : request.auth.uid;

  if (!admin) {
    if (!characterId || typeof characterId !== 'string') {
      throw new HttpsError('invalid-argument', 'characterId é obrigatório.');
    }
    if (uid !== request.auth.uid) {
      throw new HttpsError('permission-denied', 'Sem permissão.');
    }
    await assertOwnsCharacter(uid, characterId);
  }

  const db = getFirestore();
  const assets = [];

  for (const assetId of assetIds) {
    if (typeof assetId !== 'string' || !assetId || assetId.length > 128) continue;

    if (!admin) {
      const unlockSnap = await db
        .doc(`users/${uid}/characters/${characterId}/intel/${assetId}`)
        .get();
      if (!unlockSnap.exists) continue;
    }

    const assetSnap = await db.doc(`mediaAssets/${assetId}`).get();
    if (assetSnap.exists) {
      assets.push({ id: assetSnap.id, ...assetSnap.data() });
    }
  }

  return { success: true, assets };
});

/**
 * fetchQrRedirect — lookup pontual de redirect (admin ou jogador autenticado).
 */
exports.fetchQrRedirect = onCall({ region: REGION }, async (request) => {
  await assertActiveAuth(request);

  const { sourceId } = request.data || {};
  if (!sourceId || typeof sourceId !== 'string' || sourceId.length > 128) {
    throw new HttpsError('invalid-argument', 'sourceId inválido.');
  }

  const snap = await getFirestore().doc(`qrRedirects/${sourceId}`).get();
  return {
    success: true,
    targetId: snap.exists ? (snap.data()?.targetId || null) : null,
  };
});

/**
 * setCharacterCampaign — define campaignId após validar unlock do personagem ou do grupo.
 */
exports.setCharacterCampaign = onCall({ region: REGION }, async (request) => {
  await assertActiveAuth(request);

  const { characterId, campaignId, targetUid } = request.data || {};
  if (!characterId || typeof characterId !== 'string') {
    throw new HttpsError('invalid-argument', 'characterId é obrigatório.');
  }
  if (!campaignId || typeof campaignId !== 'string' || campaignId.length > 128) {
    throw new HttpsError('invalid-argument', 'campaignId inválido.');
  }

  const admin = await isRequestAdmin(request);
  const uid = admin && typeof targetUid === 'string' && targetUid
    ? targetUid
    : request.auth.uid;

  if (!admin && uid !== request.auth.uid) {
    throw new HttpsError('permission-denied', 'Sem permissão.');
  }

  const charSnap = await assertOwnsCharacter(uid, characterId);
  const charData = charSnap.data() || {};

  if (!admin) {
    const unlocked = new Set([
      ...(Array.isArray(charData.unlockedCampaigns) ? charData.unlockedCampaigns : []),
      ...(charData.campaignId ? [charData.campaignId] : []),
    ]);

    const db = getFirestore();
    const groupsSnap = await db
      .collection('groups')
      .where('memberUids', 'array-contains', uid)
      .get();

    groupsSnap.forEach((groupDoc) => {
      const g = groupDoc.data() || {};
      const slots = Array.isArray(g.characterSlots) ? g.characterSlots : [];
      const inGroup = slots.some(
        (s) => s && (s.characterId === characterId || s.uid === uid),
      );
      if (!inGroup) return;
      if (g.campaignId) unlocked.add(g.campaignId);
      if (Array.isArray(g.unlockedCampaigns)) {
        g.unlockedCampaigns.forEach((id) => {
          if (typeof id === 'string') unlocked.add(id);
        });
      }
    });

    if (!unlocked.has(campaignId)) {
      throw new HttpsError('permission-denied', 'Campanha não desbloqueada para este agente.');
    }
  }

  await getFirestore()
    .doc(`users/${uid}/characters/${characterId}`)
    .set({ campaignId }, { merge: true });

  return { success: true, campaignId };
});

/**
 * backfillGroupMemberUids — denormaliza memberUids em grupos legados (admin).
 */
exports.backfillGroupMemberUids = onCall({ region: REGION }, async (request) => {
  await assertAdminAuth(request);
  const db = getFirestore();
  const snap = await db.collection('groups').get();
  let updated = 0;

  for (const groupDoc of snap.docs) {
    const data = groupDoc.data() || {};
    const slots = Array.isArray(data.characterSlots) ? data.characterSlots : [];
    const memberUids = Array.from(
      new Set(slots.map((s) => s && s.uid).filter((uid) => typeof uid === 'string' && uid)),
    );
    const existing = Array.isArray(data.memberUids) ? data.memberUids : [];
    const same =
      existing.length === memberUids.length
      && memberUids.every((uid) => existing.includes(uid));
    if (!same) {
      await groupDoc.ref.set({ memberUids }, { merge: true });
      updated += 1;
    }
  }

  return { success: true, updated, total: snap.size };
});
