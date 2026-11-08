const crypto = require('node:crypto');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onDocumentCreated, onDocumentWritten } = require('firebase-functions/v2/firestore');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { initializeApp } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');
const functionsV1 = require('firebase-functions/v1');
const { sendToUser, logPush } = require('./push');

initializeApp();

const REGION = 'southamerica-east1';
const INVITE_DEFAULT_DAYS = 7;
const INVITE_MAX_DAYS = 30;
const INVITE_MAX_USES = 200;

/**
 * Intel embutida nos mini-apps (texto dos disquetes do reparo de disco). Existe em
 * toda mesa que liga o mini-app, por isso não tem documento em mediaAssets.
 */
const BUILTIN_INTEL_IDS = new Set(['evidence-disk-01-corrupted', 'evidence-disk-01']);

// ---------------------------------------------------------------------------
// Utilidades gerais
// ---------------------------------------------------------------------------

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

function isId(value, max = 128) {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !value.includes('/');
}

function requireId(value, name) {
  if (!isId(value)) {
    throw new HttpsError('invalid-argument', `${name} inválido.`);
  }
  return value;
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function toIso(value) {
  if (!value) return null;
  if (typeof value.toDate === 'function') return value.toDate().toISOString();
  if (value instanceof Date) return value.toISOString();
  return null;
}

function uniqueStrings(values) {
  return Array.from(new Set(values.filter((v) => typeof v === 'string' && v)));
}

/** Campanhas de um agente: a ativa + as liberadas. */
function characterCampaigns(charData) {
  return uniqueStrings([
    charData.campaignId,
    ...(Array.isArray(charData.unlockedCampaigns) ? charData.unlockedCampaigns : []),
  ]);
}

/** Campanhas de um esquadrão: a ativa + as liberadas. */
function groupCampaigns(groupData) {
  return uniqueStrings([
    groupData.campaignId,
    ...(Array.isArray(groupData.unlockedCampaigns) ? groupData.unlockedCampaigns : []),
  ]);
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

// ---------------------------------------------------------------------------
// Autorização
// ---------------------------------------------------------------------------

function isPlatformAdmin(request) {
  return request.auth?.token?.platformAdmin === true;
}

/** Exige login e conta não suspensa. Devolve o snapshot de users/{uid}. */
async function assertActiveAuth(request) {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Autenticação necessária.');
  }
  const userDoc = await getFirestore().doc(`users/${request.auth.uid}`).get();
  if (userDoc.exists && userDoc.data()?.suspended === true && !isPlatformAdmin(request)) {
    throw new HttpsError('permission-denied', 'Conta suspensa.');
  }
  return userDoc;
}

async function assertPlatformAdmin(request) {
  await assertActiveAuth(request);
  if (!isPlatformAdmin(request)) {
    throw new HttpsError('permission-denied', 'Apenas o administrador da plataforma pode executar esta operação.');
  }
}

/**
 * Acesso de mestre a uma pasta: dono (wsId == uid) ou co-mestre em members/{uid}.
 * Devolve null quando não há acesso.
 */
async function getGmAccess(uid, wsId) {
  if (!isId(wsId)) return null;
  if (uid === wsId) return { role: 'owner', campaignIds: null };
  const memberSnap = await getFirestore().doc(`workspaces/${wsId}/members/${uid}`).get();
  if (!memberSnap.exists) return null;
  const campaignIds = Array.isArray(memberSnap.data()?.campaignIds) ? memberSnap.data().campaignIds : [];
  return { role: 'cogm', campaignIds };
}

function accessCoversCampaign(access, campaignId) {
  if (!access) return false;
  if (access.role === 'owner') return true;
  return typeof campaignId === 'string' && access.campaignIds.includes(campaignId);
}

function accessCoversAny(access, campaignIds) {
  if (!access) return false;
  if (access.role === 'owner') return true;
  return campaignIds.some((c) => access.campaignIds.includes(c));
}

/** Exige mestre da pasta; com campaignId, exige acesso à campanha. */
async function assertGm(request, wsId, campaignId) {
  await assertActiveAuth(request);
  const access = await getGmAccess(request.auth.uid, wsId);
  if (!access) {
    throw new HttpsError('permission-denied', 'Sem acesso a esta pasta.');
  }
  if (campaignId !== undefined && campaignId !== null && !accessCoversCampaign(access, campaignId)) {
    throw new HttpsError('permission-denied', 'Sem acesso a esta campanha.');
  }
  return access;
}

/** Exige o dono da pasta (gestão: convites, membros, roster). */
async function assertWorkspaceOwner(request, wsId) {
  await assertActiveAuth(request);
  requireId(wsId, 'wsId');
  if (request.auth.uid !== wsId) {
    throw new HttpsError('permission-denied', 'Apenas o dono da pasta pode executar esta operação.');
  }
}

/**
 * Resolve o agente alvo de uma operação. Sem targetUid (ou igual ao chamador), é o
 * próprio agente do jogador. Com targetUid de outra conta, o chamador precisa ser
 * mestre da pasta do agente com acesso a uma campanha dele.
 */
async function resolveCharacter(request, { characterId, targetUid }) {
  requireId(characterId, 'characterId');
  const callerUid = request.auth.uid;
  const uid = isId(targetUid) ? targetUid : callerUid;

  const charSnap = await getFirestore().doc(`users/${uid}/characters/${characterId}`).get();
  if (!charSnap.exists) {
    throw new HttpsError('not-found', 'Personagem não encontrado.');
  }
  const charData = charSnap.data() || {};
  const wsId = typeof charData.workspaceId === 'string' ? charData.workspaceId : null;

  if (uid === callerUid) {
    return { uid, charSnap, charData, wsId, gmAccess: null };
  }

  const gmAccess = wsId ? await getGmAccess(callerUid, wsId) : null;
  if (!gmAccess || !accessCoversAny(gmAccess, characterCampaigns(charData))) {
    throw new HttpsError('permission-denied', 'Sem permissão para este personagem.');
  }
  return { uid, charSnap, charData, wsId, gmAccess };
}

function requireWorkspace(ctx) {
  if (!ctx.wsId) {
    throw new HttpsError('failed-precondition', 'Agente sem mesa vinculada.');
  }
  return ctx.wsId;
}

/** Item com campanha única (null = só o dono). */
function assetVisibleToGm(access, assetData) {
  if (access.role === 'owner') return true;
  return accessCoversCampaign(access, assetData.campaignId ?? null);
}

function assetVisibleToCharacter(charData, assetData) {
  const assetCampaign = assetData.campaignId ?? null;
  if (assetCampaign === null) return true;
  return characterCampaigns(charData).includes(assetCampaign);
}

async function workspaceLog(wsId, entry) {
  try {
    await getFirestore().collection(`workspaces/${wsId}/activityLog`).add({
      type: 'admin',
      source: 'admin',
      campaignId: null,
      timestamp: new Date(),
      ...entry,
    });
  } catch (err) {
    console.error('[workspaceLog] falha:', wsId, err);
  }
}

async function platformLog(entry) {
  try {
    await getFirestore().collection('platformLog').add({ timestamp: new Date(), ...entry });
  } catch (err) {
    console.error('[platformLog] falha:', err);
  }
}

// ---------------------------------------------------------------------------
// Contas
// ---------------------------------------------------------------------------

/** Cria o perfil Firestore de todo usuário novo do Auth. */
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

/** Cria o perfil de contas Auth antigas sem users/{uid} (fallback do trigger). */
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

/** Admin da plataforma: cria conta Master ID + senha (para quem não tem login próprio). */
exports.adminCreateUser = onCall({ region: REGION }, async (request) => {
  await assertPlatformAdmin(request);

  const { masterId, password } = request.data || {};
  if (!masterId || typeof masterId !== 'string' || !masterId.trim()) {
    throw new HttpsError('invalid-argument', 'masterId é obrigatório.');
  }
  if (!password || typeof password !== 'string' || password.length < 6) {
    throw new HttpsError('invalid-argument', 'Senha deve ter no mínimo 6 caracteres.');
  }

  const email = masterIdToEmail(masterId);
  let createdUid = null;

  try {
    const authUser = await getAuth().createUser({ email, password });
    createdUid = authUser.uid;

    await getFirestore().doc(`users/${createdUid}`).set({
      uid: createdUid,
      email,
      masterName: masterId.trim(),
      createdAt: FieldValue.serverTimestamp(),
      lastLogin: FieldValue.serverTimestamp(),
    }, { merge: true });

    await platformLog({
      category: 'user_created',
      actorUid: request.auth.uid,
      message: `Conta criada: ${masterId.trim()} (${createdUid.slice(0, 8)}...)`,
      metadata: { targetUid: createdUid, masterId: masterId.trim() },
    });

    return { success: true, uid: createdUid };
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

/** Admin da plataforma: troca a senha de uma conta. */
exports.adminResetPassword = onCall({ region: REGION }, async (request) => {
  await assertPlatformAdmin(request);

  const { targetUid, newPassword } = request.data || {};
  requireId(targetUid, 'targetUid');
  if (!newPassword || typeof newPassword !== 'string' || newPassword.length < 6) {
    throw new HttpsError('invalid-argument', 'Senha deve ter no mínimo 6 caracteres.');
  }
  if (targetUid === request.auth.uid) {
    throw new HttpsError('invalid-argument', 'Use as configurações do seu perfil para alterar sua própria senha.');
  }

  try {
    await getAuth().updateUser(targetUid, { password: newPassword });
    await platformLog({
      category: 'password_reset',
      actorUid: request.auth.uid,
      message: `Senha alterada para UID: ${targetUid.slice(0, 8)}...`,
      metadata: { targetUid },
    });
    return { success: true };
  } catch (error) {
    console.error('[adminResetPassword] Erro:', error);
    throw new HttpsError('internal', `Falha ao alterar senha: ${error.message}`);
  }
});

/** Admin da plataforma: suspende ou reativa uma conta. */
exports.setAccountSuspended = onCall({ region: REGION }, async (request) => {
  await assertPlatformAdmin(request);
  const { targetUid, suspended } = request.data || {};
  requireId(targetUid, 'targetUid');
  if (typeof suspended !== 'boolean') {
    throw new HttpsError('invalid-argument', 'suspended deve ser booleano.');
  }
  if (targetUid === request.auth.uid) {
    throw new HttpsError('invalid-argument', 'Você não pode suspender a própria conta.');
  }
  await getFirestore().doc(`users/${targetUid}`).set({ suspended }, { merge: true });
  if (suspended) {
    await getAuth().revokeRefreshTokens(targetUid);
  }
  await platformLog({
    category: suspended ? 'account_suspended' : 'account_reactivated',
    actorUid: request.auth.uid,
    metadata: { targetUid },
  });
  return { success: true };
});

/** Admin da plataforma: lista contas (dados de conta apenas, sem conteúdo de pasta). */
exports.listAccounts = onCall({ region: REGION }, async (request) => {
  await assertPlatformAdmin(request);
  const { pageToken, limit } = request.data || {};
  const max = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const page = await getAuth().listUsers(max, typeof pageToken === 'string' && pageToken ? pageToken : undefined);

  const db = getFirestore();
  const refs = page.users.map((u) => db.doc(`users/${u.uid}`));
  const snaps = refs.length ? await db.getAll(...refs) : [];
  const byUid = new Map(snaps.map((s) => [s.id, s.exists ? s.data() : {}]));

  return {
    success: true,
    nextPageToken: page.pageToken || null,
    accounts: page.users.map((u) => {
      const profile = byUid.get(u.uid) || {};
      return {
        uid: u.uid,
        email: u.email || null,
        masterName: profile.masterName || null,
        displayName: profile.displayName || u.displayName || null,
        suspended: profile.suspended === true || u.disabled === true,
        createdAt: u.metadata.creationTime || null,
        lastSignIn: u.metadata.lastSignInTime || null,
        providers: u.providerData.map((p) => p.providerId),
      };
    }),
  };
});

/**
 * Conta alterada: copia para o roster das mesas onde a pessoa joga os campos que
 * o mestre precisa ver (nome, último acesso, suspensão), já que o mestre não lê
 * a conta pessoal.
 */
exports.syncAccountToRosters = onDocumentWritten(
  { document: 'users/{uid}', region: REGION },
  async (event) => {
    const { uid } = event.params;
    const before = event.data?.before?.exists ? event.data.before.data() : null;
    const after = event.data?.after?.exists ? event.data.after.data() : null;
    if (!after) return;
    const pick = (d) => ({
      displayName: d?.displayName || d?.masterName || null,
      masterName: d?.masterName || null,
      lastLogin: d?.lastLogin || null,
      suspended: d?.suspended === true,
    });
    const next = pick(after);
    const prev = pick(before);
    const sameTime = (a, b) => (a?.toMillis?.() ?? null) === (b?.toMillis?.() ?? null);
    if (
      before
      && next.displayName === prev.displayName
      && next.masterName === prev.masterName
      && next.suspended === prev.suspended
      && sameTime(next.lastLogin, prev.lastLogin)
    ) return;

    const db = getFirestore();
    const memberships = await db.collection(`users/${uid}/memberships`).where('isPlayer', '==', true).get();
    await Promise.all(memberships.docs.map(async (m) => {
      const rosterRef = db.doc(`workspaces/${m.id}/players/${uid}`);
      const snap = await rosterRef.get();
      if (snap.exists) await rosterRef.set(next, { merge: true });
    }));
  },
);

exports.aggregateUserCreation = onDocumentCreated(
  { document: 'users/{userId}', region: REGION },
  async () => {
    try {
      await getFirestore().doc('platformStats/global').set(
        { totalUsers: FieldValue.increment(1), lastUpdatedAt: FieldValue.serverTimestamp() },
        { merge: true },
      );
    } catch (err) {
      console.error('[aggregateUserCreation] Erro:', err);
    }
  },
);

// ---------------------------------------------------------------------------
// Convites
// ---------------------------------------------------------------------------

async function displayNameOf(uid) {
  const snap = await getFirestore().doc(`users/${uid}`).get();
  const data = snap.exists ? snap.data() || {} : {};
  return {
    displayName: data.displayName || data.masterName || null,
    masterName: data.masterName || null,
  };
}

function inviteStatus(invite) {
  if (!invite) return 'not-found';
  if (invite.revoked === true) return 'revoked';
  const expiresAt = invite.expiresAt?.toDate ? invite.expiresAt.toDate() : null;
  if (expiresAt && expiresAt.getTime() < Date.now()) return 'expired';
  if ((invite.uses || 0) >= (invite.maxUses || 1)) return 'exhausted';
  return 'valid';
}

/** Dono da pasta cria convite de co-mestre ou de jogador para uma campanha. */
exports.createInvite = onCall({ region: REGION }, async (request) => {
  const { wsId, kind, campaignId, squadId, maxUses, expiresInDays } = request.data || {};
  await assertWorkspaceOwner(request, wsId);
  requireId(campaignId, 'campaignId');
  if (kind !== 'cogm' && kind !== 'player') {
    throw new HttpsError('invalid-argument', 'kind deve ser "cogm" ou "player".');
  }

  const db = getFirestore();
  const campaignSnap = await db.doc(`workspaces/${wsId}/campaigns/${campaignId}`).get();
  if (!campaignSnap.exists) {
    throw new HttpsError('not-found', 'Campanha não encontrada nesta pasta.');
  }
  let resolvedSquad = null;
  if (kind === 'player' && squadId !== undefined && squadId !== null && squadId !== '') {
    requireId(squadId, 'squadId');
    const squadSnap = await db.doc(`workspaces/${wsId}/groups/${squadId}`).get();
    if (!squadSnap.exists) {
      throw new HttpsError('not-found', 'Esquadrão não encontrado nesta pasta.');
    }
    resolvedSquad = squadId;
  }

  const defaultUses = kind === 'cogm' ? 1 : 50;
  const uses = Math.min(Math.max(Math.floor(Number(maxUses) || defaultUses), 1), INVITE_MAX_USES);
  const days = Math.min(Math.max(Number(expiresInDays) || INVITE_DEFAULT_DAYS, 1), INVITE_MAX_DAYS);
  const token = crypto.randomBytes(16).toString('base64url');
  const inviteId = hashToken(token);
  const expiresAt = Timestamp.fromMillis(Date.now() + days * 24 * 60 * 60 * 1000);

  await db.doc(`invites/${inviteId}`).set({
    wsId,
    kind,
    campaignId,
    squadId: resolvedSquad,
    createdBy: request.auth.uid,
    createdAt: FieldValue.serverTimestamp(),
    expiresAt,
    maxUses: uses,
    uses: 0,
    revoked: false,
  });

  await workspaceLog(wsId, {
    category: 'invite_created',
    uid: request.auth.uid,
    campaignId,
    message: `Convite de ${kind === 'cogm' ? 'co-mestre' : 'jogador'} criado`,
    metadata: { inviteId: inviteId.slice(0, 12), kind, maxUses: uses },
  });

  return { success: true, token, inviteId, expiresAt: expiresAt.toDate().toISOString(), maxUses: uses };
});

/** Dono da pasta lista os convites (sem tokens). */
exports.listInvites = onCall({ region: REGION }, async (request) => {
  const { wsId, campaignId } = request.data || {};
  await assertWorkspaceOwner(request, wsId);
  let q = getFirestore().collection('invites').where('wsId', '==', wsId);
  if (isId(campaignId)) q = q.where('campaignId', '==', campaignId);
  const snap = await q.get();
  return {
    success: true,
    invites: snap.docs.map((d) => {
      const data = d.data() || {};
      return {
        id: d.id,
        kind: data.kind,
        campaignId: data.campaignId,
        squadId: data.squadId || null,
        createdAt: toIso(data.createdAt),
        expiresAt: toIso(data.expiresAt),
        maxUses: data.maxUses || 1,
        uses: data.uses || 0,
        revoked: data.revoked === true,
      };
    }),
  };
});

exports.revokeInvite = onCall({ region: REGION }, async (request) => {
  const { wsId, inviteId } = request.data || {};
  await assertWorkspaceOwner(request, wsId);
  requireId(inviteId, 'inviteId');
  const ref = getFirestore().doc(`invites/${inviteId}`);
  const snap = await ref.get();
  if (!snap.exists || snap.data()?.wsId !== wsId) {
    throw new HttpsError('not-found', 'Convite não encontrado.');
  }
  await ref.set({ revoked: true, revokedAt: FieldValue.serverTimestamp() }, { merge: true });
  return { success: true };
});

/** Mostra para quem recebeu o link o que o convite concede, antes de aceitar. */
exports.getInvitePreview = onCall({ region: REGION }, async (request) => {
  const { token } = request.data || {};
  if (typeof token !== 'string' || token.length < 10 || token.length > 64) {
    return { kind: 'player', workspaceName: '', campaignName: '', valid: false, reason: 'not-found' };
  }
  const db = getFirestore();
  const snap = await db.doc(`invites/${hashToken(token)}`).get();
  const invite = snap.exists ? snap.data() : null;
  const status = inviteStatus(invite);
  if (!invite) {
    return { kind: 'player', workspaceName: '', campaignName: '', valid: false, reason: 'not-found' };
  }
  const [wsSnap, campSnap] = await Promise.all([
    db.doc(`workspaces/${invite.wsId}`).get(),
    db.doc(`workspaces/${invite.wsId}/campaigns/${invite.campaignId}`).get(),
  ]);
  return {
    kind: invite.kind,
    workspaceName: wsSnap.exists ? wsSnap.data()?.name || '' : '',
    campaignName: campSnap.exists ? campSnap.data()?.name || '' : '',
    valid: status === 'valid',
    ...(status === 'valid' ? {} : { reason: status }),
  };
});

/**
 * Aceita um convite. Co-mestre: entra em members/{uid} com a campanha. Jogador:
 * entra no roster, ganha (ou reaproveita) um agente na mesa e, se o convite tiver
 * esquadrão, ocupa uma vaga nele. Tudo numa transação, com o contador de usos.
 */
exports.acceptInvite = onCall({ region: REGION }, async (request) => {
  await assertActiveAuth(request);
  const { token, codinome } = request.data || {};
  if (typeof token !== 'string' || token.length < 10 || token.length > 64) {
    throw new HttpsError('invalid-argument', 'Convite inválido.');
  }
  const uid = request.auth.uid;
  const db = getFirestore();
  const inviteRef = db.doc(`invites/${hashToken(token)}`);
  const names = await displayNameOf(uid);

  const result = await db.runTransaction(async (tx) => {
    const inviteSnap = await tx.get(inviteRef);
    const invite = inviteSnap.exists ? inviteSnap.data() : null;
    const status = inviteStatus(invite);
    if (status !== 'valid') {
      throw new HttpsError('failed-precondition', `Convite ${status}.`);
    }
    const { wsId, campaignId, kind } = invite;
    const wsRef = db.doc(`workspaces/${wsId}`);
    const campaignRef = db.doc(`workspaces/${wsId}/campaigns/${campaignId}`);
    const membershipRef = db.doc(`users/${uid}/memberships/${wsId}`);

    const [wsSnap, campaignSnap] = await Promise.all([tx.get(wsRef), tx.get(campaignRef)]);
    if (!wsSnap.exists || !campaignSnap.exists) {
      throw new HttpsError('not-found', 'A campanha deste convite não existe mais.');
    }
    const workspaceName = wsSnap.data()?.name || '';

    if (kind === 'cogm') {
      if (uid === wsId) {
        throw new HttpsError('failed-precondition', 'Você já é o dono desta pasta.');
      }
      const memberRef = db.doc(`workspaces/${wsId}/members/${uid}`);
      const memberSnap = await tx.get(memberRef);
      tx.set(memberRef, {
        uid,
        campaignIds: FieldValue.arrayUnion(campaignId),
        displayName: names.displayName,
        invitedBy: invite.createdBy || wsId,
        ...(memberSnap.exists ? {} : { joinedAt: FieldValue.serverTimestamp() }),
      }, { merge: true });
      tx.set(membershipRef, {
        wsId,
        workspaceName,
        cogmCampaignIds: FieldValue.arrayUnion(campaignId),
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      tx.update(inviteRef, { uses: FieldValue.increment(1), lastUsedAt: FieldValue.serverTimestamp() });
      return { kind, wsId, campaignId, characterId: null };
    }

    // Convite de jogador.
    const charsQuery = db.collection(`users/${uid}/characters`).where('workspaceId', '==', wsId);
    const charsSnap = await tx.get(charsQuery);
    const existing = charsSnap.docs.find((d) => d.data()?.archived !== true) || null;
    const rosterRef = db.doc(`workspaces/${wsId}/players/${uid}`);
    const rosterSnap = await tx.get(rosterRef);
    const squadRef = invite.squadId ? db.doc(`workspaces/${wsId}/groups/${invite.squadId}`) : null;
    const squadSnap = squadRef ? await tx.get(squadRef) : null;

    let characterId;
    if (existing) {
      characterId = existing.id;
      const data = existing.data() || {};
      tx.set(existing.ref, {
        unlockedCampaigns: FieldValue.arrayUnion(campaignId),
        ...(data.campaignId ? {} : { campaignId }),
      }, { merge: true });
    } else {
      const name = typeof codinome === 'string' && codinome.trim()
        ? codinome.trim().slice(0, 60)
        : (names.masterName || 'Agente');
      const charRef = db.collection(`users/${uid}/characters`).doc();
      characterId = charRef.id;
      tx.set(charRef, {
        codinome: name,
        agentStatus: 'vivo',
        dangerLevel: 1,
        archived: false,
        workspaceId: wsId,
        campaignId,
        unlockedCampaigns: [campaignId],
        createdAt: FieldValue.serverTimestamp(),
      });
    }

    tx.set(rosterRef, {
      uid,
      displayName: names.displayName,
      masterName: names.masterName,
      characterIds: FieldValue.arrayUnion(characterId),
      campaignIds: FieldValue.arrayUnion(campaignId),
      status: 'active',
      ...(rosterSnap.exists ? {} : { joinedAt: FieldValue.serverTimestamp() }),
    }, { merge: true });

    if (squadSnap && squadSnap.exists) {
      const squad = squadSnap.data() || {};
      const slots = Array.isArray(squad.characterSlots) ? squad.characterSlots : [];
      if (!slots.some((s) => s && s.characterId === characterId && s.uid === uid)) {
        tx.update(squadRef, {
          characterSlots: [...slots, { uid, characterId, joinedAt: Timestamp.now() }],
          memberUids: FieldValue.arrayUnion(uid),
          updatedAt: FieldValue.serverTimestamp(),
        });
      }
    }

    tx.set(membershipRef, {
      wsId,
      workspaceName,
      isPlayer: true,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    tx.update(inviteRef, { uses: FieldValue.increment(1), lastUsedAt: FieldValue.serverTimestamp() });
    return { kind, wsId, campaignId, characterId };
  });

  await workspaceLog(result.wsId, {
    category: result.kind === 'cogm' ? 'cogm_joined' : 'player_joined',
    uid,
    campaignId: result.campaignId,
    username: names.displayName,
    message: result.kind === 'cogm' ? 'Co-mestre entrou na campanha' : 'Jogador entrou na mesa',
  });

  return { success: true, ...result };
});

/** Dono tira um co-mestre de uma campanha (ou de todas, sem campaignId). */
exports.removeCoGm = onCall({ region: REGION }, async (request) => {
  const { wsId, uid, campaignId } = request.data || {};
  await assertWorkspaceOwner(request, wsId);
  requireId(uid, 'uid');
  const db = getFirestore();
  const memberRef = db.doc(`workspaces/${wsId}/members/${uid}`);
  const membershipRef = db.doc(`users/${uid}/memberships/${wsId}`);
  const snap = await memberRef.get();
  if (!snap.exists) return { success: true, removed: false };

  const current = Array.isArray(snap.data()?.campaignIds) ? snap.data().campaignIds : [];
  const remaining = isId(campaignId) ? current.filter((c) => c !== campaignId) : [];
  const batch = db.batch();
  if (remaining.length === 0) {
    batch.delete(memberRef);
    batch.set(membershipRef, { cogmCampaignIds: [], updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  } else {
    batch.update(memberRef, { campaignIds: remaining });
    batch.set(membershipRef, { cogmCampaignIds: remaining, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  }
  await batch.commit();
  await workspaceLog(wsId, {
    category: 'cogm_removed',
    uid: request.auth.uid,
    campaignId: isId(campaignId) ? campaignId : null,
    metadata: { targetUid: uid },
  });
  return { success: true, removed: true, remaining };
});

/** Dono tira um jogador da mesa: sai do roster e dos esquadrões; os agentes ficam arquivados. */
exports.removePlayer = onCall({ region: REGION }, async (request) => {
  const { wsId, uid } = request.data || {};
  await assertWorkspaceOwner(request, wsId);
  requireId(uid, 'uid');
  const db = getFirestore();

  const [groupsSnap, charsSnap] = await Promise.all([
    db.collection(`workspaces/${wsId}/groups`).where('memberUids', 'array-contains', uid).get(),
    db.collection(`users/${uid}/characters`).where('workspaceId', '==', wsId).get(),
  ]);

  const batch = db.batch();
  groupsSnap.forEach((g) => {
    const data = g.data() || {};
    const slots = (Array.isArray(data.characterSlots) ? data.characterSlots : []).filter((s) => s?.uid !== uid);
    batch.update(g.ref, {
      characterSlots: slots,
      memberUids: FieldValue.arrayRemove(uid),
      updatedAt: FieldValue.serverTimestamp(),
    });
  });
  charsSnap.forEach((c) => batch.set(c.ref, { archived: true }, { merge: true }));
  batch.delete(db.doc(`workspaces/${wsId}/players/${uid}`));
  batch.set(db.doc(`users/${uid}/memberships/${wsId}`), {
    isPlayer: false,
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
  await batch.commit();

  await workspaceLog(wsId, {
    category: 'player_removed',
    uid: request.auth.uid,
    metadata: { targetUid: uid, characters: charsSnap.size },
  });
  return { success: true };
});

/** Dono cria um agente extra para um jogador que já está na mesa. */
exports.gmCreateCharacter = onCall({ region: REGION }, async (request) => {
  const { wsId, uid, codinome, campaignId } = request.data || {};
  await assertWorkspaceOwner(request, wsId);
  requireId(uid, 'uid');
  const name = typeof codinome === 'string' ? codinome.trim().slice(0, 60) : '';
  if (!name) {
    throw new HttpsError('invalid-argument', 'codinome é obrigatório.');
  }
  const db = getFirestore();
  const rosterSnap = await db.doc(`workspaces/${wsId}/players/${uid}`).get();
  if (!rosterSnap.exists) {
    throw new HttpsError('failed-precondition', 'Esta conta não joga nesta mesa. Envie um convite.');
  }
  let campaign = null;
  if (isId(campaignId)) {
    const campSnap = await db.doc(`workspaces/${wsId}/campaigns/${campaignId}`).get();
    if (!campSnap.exists) throw new HttpsError('not-found', 'Campanha não encontrada nesta pasta.');
    campaign = campaignId;
  }
  const charRef = db.collection(`users/${uid}/characters`).doc();
  await charRef.set({
    codinome: name,
    agentStatus: 'vivo',
    dangerLevel: 1,
    archived: false,
    workspaceId: wsId,
    ...(campaign ? { campaignId: campaign, unlockedCampaigns: [campaign] } : {}),
    createdAt: FieldValue.serverTimestamp(),
  });
  return { success: true, characterId: charRef.id };
});

/** Dono move um agente (com progresso) para outro jogador da mesma mesa. */
exports.transferCharacter = onCall({ region: REGION }, async (request) => {
  const { wsId, fromUid, toUid, characterId } = request.data || {};
  await assertWorkspaceOwner(request, wsId);
  requireId(fromUid, 'fromUid');
  requireId(toUid, 'toUid');
  requireId(characterId, 'characterId');
  if (fromUid === toUid) {
    throw new HttpsError('invalid-argument', 'Origem e destino são a mesma conta.');
  }
  const db = getFirestore();
  const fromRef = db.doc(`users/${fromUid}/characters/${characterId}`);
  const toRef = db.doc(`users/${toUid}/characters/${characterId}`);
  const [charSnap, targetRoster, existingTarget] = await Promise.all([
    fromRef.get(),
    db.doc(`workspaces/${wsId}/players/${toUid}`).get(),
    toRef.get(),
  ]);
  if (!charSnap.exists || charSnap.data()?.workspaceId !== wsId) {
    throw new HttpsError('not-found', 'Agente não encontrado nesta mesa.');
  }
  if (!targetRoster.exists) {
    throw new HttpsError('failed-precondition', 'A conta de destino não joga nesta mesa.');
  }
  if (existingTarget.exists) {
    throw new HttpsError('already-exists', 'A conta de destino já tem um agente com este id.');
  }

  const subcollections = ['intel', 'achievements', 'stats'];
  const subSnaps = await Promise.all(subcollections.map((name) => fromRef.collection(name).get()));
  const writes = [];
  writes.push((b) => b.set(toRef, charSnap.data()));
  subSnaps.forEach((snap, i) => snap.docs.forEach((d) => {
    writes.push((b) => b.set(toRef.collection(subcollections[i]).doc(d.id), d.data()));
  }));
  subSnaps.forEach((snap) => snap.docs.forEach((d) => writes.push((b) => b.delete(d.ref))));
  writes.push((b) => b.delete(fromRef));

  // Esquadrões: a vaga passa a apontar para a nova conta.
  const groupsSnap = await db.collection(`workspaces/${wsId}/groups`).where('memberUids', 'array-contains', fromUid).get();
  groupsSnap.forEach((g) => {
    const slots = (g.data()?.characterSlots || []).map((s) =>
      s && s.characterId === characterId && s.uid === fromUid ? { ...s, uid: toUid } : s);
    writes.push((b) => b.update(g.ref, { characterSlots: slots, updatedAt: FieldValue.serverTimestamp() }));
  });

  for (let i = 0; i < writes.length; i += 400) {
    const batch = db.batch();
    writes.slice(i, i + 400).forEach((w) => w(batch));
    await batch.commit();
  }
  await Promise.all([recomputeRoster(wsId, fromUid), recomputeRoster(wsId, toUid)]);
  await workspaceLog(wsId, {
    category: 'character_transferred',
    uid: request.auth.uid,
    metadata: { characterId, fromUid, toUid },
  });
  return { success: true };
});

// ---------------------------------------------------------------------------
// Consistência: esquadrões e roster
// ---------------------------------------------------------------------------

/** Recalcula players/{uid}.campaignIds e characterIds a partir de agentes e esquadrões. */
async function recomputeRoster(wsId, uid) {
  const db = getFirestore();
  const rosterRef = db.doc(`workspaces/${wsId}/players/${uid}`);
  const rosterSnap = await rosterRef.get();
  if (!rosterSnap.exists) return;

  const [charsSnap, groupsSnap] = await Promise.all([
    db.collection(`users/${uid}/characters`).where('workspaceId', '==', wsId).get(),
    db.collection(`workspaces/${wsId}/groups`).where('memberUids', 'array-contains', uid).get(),
  ]);

  const activeChars = charsSnap.docs.filter((d) => d.data()?.archived !== true);
  const charIds = new Set(activeChars.map((d) => d.id));
  const campaigns = new Set();
  activeChars.forEach((d) => characterCampaigns(d.data() || {}).forEach((c) => campaigns.add(c)));
  groupsSnap.forEach((g) => {
    const data = g.data() || {};
    const slots = Array.isArray(data.characterSlots) ? data.characterSlots : [];
    if (!slots.some((s) => s && s.uid === uid && charIds.has(s.characterId))) return;
    groupCampaigns(data).forEach((c) => campaigns.add(c));
  });

  const next = { campaignIds: Array.from(campaigns).sort(), characterIds: Array.from(charIds).sort() };
  const current = rosterSnap.data() || {};
  const same = (a, b) => Array.isArray(a) && a.length === b.length && [...a].sort().every((v, i) => v === b[i]);
  if (same(current.campaignIds, next.campaignIds) && same(current.characterIds, next.characterIds)) return;
  await rosterRef.set(next, { merge: true });
}

/**
 * Esquadrão alterado: deriva campaignIds (campaignId ∪ unlockedCampaigns) e memberUids
 * (das vagas), e recalcula o roster de quem entrou ou saiu.
 */
exports.syncGroup = onDocumentWritten(
  { document: 'workspaces/{wsId}/groups/{groupId}', region: REGION },
  async (event) => {
    const { wsId } = event.params;
    const before = event.data?.before?.exists ? event.data.before.data() : null;
    const after = event.data?.after?.exists ? event.data.after.data() : null;

    if (after) {
      const slots = Array.isArray(after.characterSlots) ? after.characterSlots : [];
      const memberUids = uniqueStrings(slots.map((s) => s && s.uid)).sort();
      const campaignIds = groupCampaigns(after).sort();
      const sameList = (a, b) =>
        Array.isArray(a) && a.length === b.length && [...a].sort().every((v, i) => v === b[i]);
      if (!sameList(after.memberUids, memberUids) || !sameList(after.campaignIds, campaignIds)) {
        await event.data.after.ref.set({ memberUids, campaignIds }, { merge: true });
        return; // a escrita dispara o trigger de novo, já consistente
      }
    }

    const uids = uniqueStrings([
      ...(Array.isArray(before?.memberUids) ? before.memberUids : []),
      ...(Array.isArray(after?.memberUids) ? after.memberUids : []),
    ]);
    await Promise.all(uids.map((uid) => recomputeRoster(wsId, uid)));
  },
);

/** Agente alterado: recalcula o roster nas pastas envolvidas. */
exports.syncCharacterRoster = onDocumentWritten(
  { document: 'users/{uid}/characters/{characterId}', region: REGION },
  async (event) => {
    const { uid } = event.params;
    const before = event.data?.before?.exists ? event.data.before.data() : null;
    const after = event.data?.after?.exists ? event.data.after.data() : null;
    const relevant = (d) => d && [d.workspaceId, d.campaignId, d.archived, JSON.stringify(d.unlockedCampaigns || [])];
    if (before && after && JSON.stringify(relevant(before)) === JSON.stringify(relevant(after))) return;
    const wsIds = uniqueStrings([before?.workspaceId, after?.workspaceId]);
    await Promise.all(wsIds.map((wsId) => recomputeRoster(wsId, uid)));
  },
);

// ---------------------------------------------------------------------------
// Analytics por pasta
// ---------------------------------------------------------------------------

exports.aggregatePlayEvent = onDocumentCreated(
  { document: 'workspaces/{wsId}/playEvents/{eventId}', region: REGION },
  async (event) => {
    const data = event.data?.data();
    if (!data) return;
    const { wsId } = event.params;
    const playedAt = data.playedAt?.toDate ? data.playedAt.toDate() : new Date();
    const dateKey = playedAt.toISOString().slice(0, 10);
    const tapeId = typeof data.tapeId === 'string' && data.tapeId ? data.tapeId.replace(/[.\/]/g, '_') : 'unknown';

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
      await getFirestore().doc(`workspaces/${wsId}/stats/analytics`).set(updateData, { merge: true });
    } catch (err) {
      console.error('[aggregatePlayEvent] Erro:', err);
    }
  },
);

// ---------------------------------------------------------------------------
// Intel, conquistas e QR
// ---------------------------------------------------------------------------

/** Confere se o código escaneado autoriza o intelId (QR do próprio item ou redirect da pasta). */
async function qrAuthorizes(wsId, sourceCode, intelId) {
  const scanned = typeof sourceCode === 'string' ? sourceCode.trim() : '';
  if (scanned && scanned === intelId) return true;
  const codes = uniqueStrings([scanned, intelId]).filter((c) => isId(c));
  const db = getFirestore();
  for (const code of codes) {
    const redirectSnap = await db.doc(`workspaces/${wsId}/qrRedirects/${code}`).get();
    if (!redirectSnap.exists) continue;
    const targetId = redirectSnap.data()?.targetId || code;
    if (targetId === intelId) return true;
  }
  return false;
}

/**
 * Desbloqueia intel num agente. Jogador: exige QR válido da pasta do agente e item
 * da campanha dele. Mestre: entrega direta, dentro das campanhas a que tem acesso.
 */
exports.unlockIntel = onCall({ region: REGION }, async (request) => {
  await assertActiveAuth(request);
  const { characterId, intelId, campaignId, targetUid, sourceCode } = request.data || {};
  requireId(intelId, 'intelId');
  const ctx = await resolveCharacter(request, { characterId, targetUid });
  const wsId = requireWorkspace(ctx);

  const db = getFirestore();
  const intelRef = db.doc(`users/${ctx.uid}/characters/${characterId}/intel/${intelId}`);

  if (BUILTIN_INTEL_IDS.has(intelId)) {
    await intelRef.set({
      intelId,
      unlockedAt: FieldValue.serverTimestamp(),
      campaignId: ctx.charData.campaignId || null,
      workspaceId: wsId,
      type: 'TEXT',
      source: ctx.gmAccess ? 'admin' : 'player',
    }, { merge: true });
    return { success: true, intelId };
  }

  const assetSnap = await db.doc(`workspaces/${wsId}/mediaAssets/${intelId}`).get();
  if (!assetSnap.exists) {
    throw new HttpsError('not-found', 'Intel não encontrada nesta mesa.');
  }
  const asset = assetSnap.data() || {};

  if (ctx.gmAccess) {
    if (!assetVisibleToGm(ctx.gmAccess, asset)) {
      throw new HttpsError('permission-denied', 'Intel fora das suas campanhas.');
    }
  } else {
    const existingUnlock = await intelRef.get();
    if (!existingUnlock.exists) {
      if (!assetVisibleToCharacter(ctx.charData, asset)) {
        throw new HttpsError('permission-denied', 'Intel de outra campanha.');
      }
      if (!(await qrAuthorizes(wsId, sourceCode, intelId))) {
        throw new HttpsError('permission-denied', 'Desbloqueio de mídia remota requer código QR válido.');
      }
    }
  }

  const resolvedCampaign = isId(campaignId) && characterCampaigns(ctx.charData).includes(campaignId)
    ? campaignId
    : (asset.campaignId || ctx.charData.campaignId || null);

  await intelRef.set({
    intelId,
    unlockedAt: FieldValue.serverTimestamp(),
    campaignId: resolvedCampaign,
    workspaceId: wsId,
    type: 'AUDIO',
    source: ctx.gmAccess ? 'admin' : 'player',
  }, { merge: true });

  return { success: true, intelId };
});

/** Concede conquistas a um agente (o próprio jogador ou um mestre da mesa). */
exports.grantAchievements = onCall({ region: REGION }, async (request) => {
  await assertActiveAuth(request);
  const { characterId, achievementIds, targetUid, campaignId, platform } = request.data || {};
  if (!Array.isArray(achievementIds) || achievementIds.length === 0 || achievementIds.length > 50) {
    throw new HttpsError('invalid-argument', 'achievementIds inválido.');
  }
  const ctx = await resolveCharacter(request, { characterId, targetUid });
  const wsId = requireWorkspace(ctx);

  const allowedCampaigns = characterCampaigns(ctx.charData);
  const resolvedCampaign = isId(campaignId) && allowedCampaigns.includes(campaignId) ? campaignId : 'unscoped';
  if (ctx.gmAccess && resolvedCampaign !== 'unscoped' && !accessCoversCampaign(ctx.gmAccess, resolvedCampaign)) {
    throw new HttpsError('permission-denied', 'Sem acesso a esta campanha.');
  }
  const resolvedPlatform = platform === 'nokia' || platform === 'walkman' || platform === 'global'
    ? platform
    : 'walkman';

  const db = getFirestore();
  const batch = db.batch();
  for (const id of achievementIds) {
    if (!isId(id)) {
      throw new HttpsError('invalid-argument', 'achievementId inválido.');
    }
    const isComposite = id.includes('__');
    const baseId = isComposite ? id.slice(0, id.lastIndexOf('__')) : id;
    const campFromDoc = isComposite ? id.slice(id.lastIndexOf('__') + 2) : resolvedCampaign;
    if (campFromDoc !== 'unscoped' && !allowedCampaigns.includes(campFromDoc)) {
      throw new HttpsError('permission-denied', 'Conquista de campanha não liberada ao agente.');
    }
    const docId = `${baseId}__${campFromDoc}`;
    batch.set(db.doc(`users/${ctx.uid}/characters/${characterId}/achievements/${docId}`), {
      achievementId: baseId,
      campaignId: campFromDoc,
      workspaceId: wsId,
      platform: resolvedPlatform,
      unlockedAt: FieldValue.serverTimestamp(),
      source: ctx.gmAccess ? 'admin' : 'player',
    }, { merge: true });
  }
  await batch.commit();
  return { success: true, count: achievementIds.length };
});

/**
 * Pasta de uma consulta de QR/mídia: do agente (jogador ou mestre agindo sobre ele)
 * ou, sem agente, a pasta informada pelo mestre.
 */
async function resolveLookupContext(request, { characterId, targetUid, wsId }) {
  if (isId(characterId)) {
    const ctx = await resolveCharacter(request, { characterId, targetUid });
    return { wsId: requireWorkspace(ctx), charData: ctx.charData, gmAccess: ctx.gmAccess, uid: ctx.uid };
  }
  const gmAccess = await assertGm(request, wsId);
  return { wsId, charData: null, gmAccess, uid: null };
}

/** Resolve um QR/código para um item da pasta (sem expor o catálogo). */
exports.resolveIntelCode = onCall({ region: REGION }, async (request) => {
  await assertActiveAuth(request);
  const { code: rawCode, characterId, targetUid, wsId } = request.data || {};
  const code = typeof rawCode === 'string' ? rawCode.trim() : '';
  if (!isId(code)) {
    throw new HttpsError('invalid-argument', 'code inválido.');
  }
  const ctx = await resolveLookupContext(request, { characterId, targetUid, wsId });
  const db = getFirestore();

  const redirectSnap = await db.doc(`workspaces/${ctx.wsId}/qrRedirects/${code}`).get();
  const viaRedirect = redirectSnap.exists;
  const finalCode = viaRedirect ? (redirectSnap.data()?.targetId || code) : code;
  if (!isId(finalCode)) {
    return { success: true, redirectedId: null, asset: null };
  }

  const assetSnap = await db.doc(`workspaces/${ctx.wsId}/mediaAssets/${finalCode}`).get();
  const asset = assetSnap.exists ? assetSnap.data() || {} : null;
  const visible = asset && (ctx.gmAccess ? assetVisibleToGm(ctx.gmAccess, asset) : assetVisibleToCharacter(ctx.charData, asset));
  if (!visible) {
    return { success: true, redirectedId: viaRedirect ? finalCode : null, asset: null };
  }
  return {
    success: true,
    redirectedId: viaRedirect ? finalCode : (finalCode !== code ? finalCode : null),
    asset: { id: assetSnap.id, ...asset, _viaQr: true },
  };
});

/** Devolve itens da pasta: para o jogador, só os desbloqueados no agente. */
exports.getMediaAssetsByIds = onCall({ region: REGION }, async (request) => {
  await assertActiveAuth(request);
  const { characterId, assetIds, targetUid, wsId } = request.data || {};
  if (!Array.isArray(assetIds) || assetIds.length === 0 || assetIds.length > 50) {
    throw new HttpsError('invalid-argument', 'assetIds inválido.');
  }
  const ctx = await resolveLookupContext(request, { characterId, targetUid, wsId });
  const db = getFirestore();
  const ids = uniqueStrings(assetIds).filter((id) => isId(id));
  const assets = [];

  for (const assetId of ids) {
    if (!ctx.gmAccess) {
      const unlockSnap = await db.doc(`users/${ctx.uid}/characters/${characterId}/intel/${assetId}`).get();
      if (!unlockSnap.exists) continue;
    }
    const assetSnap = await db.doc(`workspaces/${ctx.wsId}/mediaAssets/${assetId}`).get();
    if (!assetSnap.exists) continue;
    const data = assetSnap.data() || {};
    if (ctx.gmAccess && !assetVisibleToGm(ctx.gmAccess, data)) continue;
    assets.push({ id: assetSnap.id, ...data });
  }
  return { success: true, assets };
});

/** Lookup pontual de redirect de QR na pasta do agente (ou na pasta do mestre). */
exports.fetchQrRedirect = onCall({ region: REGION }, async (request) => {
  await assertActiveAuth(request);
  const { sourceId, characterId, targetUid, wsId } = request.data || {};
  requireId(sourceId, 'sourceId');
  const ctx = await resolveLookupContext(request, { characterId, targetUid, wsId });
  const snap = await getFirestore().doc(`workspaces/${ctx.wsId}/qrRedirects/${sourceId}`).get();
  if (!snap.exists) return { success: true, targetId: null };
  const data = snap.data() || {};
  if (ctx.gmAccess && !assetVisibleToGm(ctx.gmAccess, data)) return { success: true, targetId: null };
  return { success: true, targetId: data.targetId || null };
});

/** Define a campanha ativa do agente, validando que ela foi liberada a ele ou ao esquadrão. */
exports.setCharacterCampaign = onCall({ region: REGION }, async (request) => {
  await assertActiveAuth(request);
  const { characterId, campaignId, targetUid } = request.data || {};
  requireId(campaignId, 'campaignId');
  const ctx = await resolveCharacter(request, { characterId, targetUid });
  const wsId = requireWorkspace(ctx);
  const db = getFirestore();

  const campaignSnap = await db.doc(`workspaces/${wsId}/campaigns/${campaignId}`).get();
  if (!campaignSnap.exists) {
    throw new HttpsError('not-found', 'Campanha não encontrada nesta mesa.');
  }

  if (ctx.gmAccess) {
    if (!accessCoversCampaign(ctx.gmAccess, campaignId)) {
      throw new HttpsError('permission-denied', 'Sem acesso a esta campanha.');
    }
  } else {
    const unlocked = new Set(characterCampaigns(ctx.charData));
    const groupsSnap = await db
      .collection(`workspaces/${wsId}/groups`)
      .where('memberUids', 'array-contains', ctx.uid)
      .get();
    groupsSnap.forEach((groupDoc) => {
      const g = groupDoc.data() || {};
      const slots = Array.isArray(g.characterSlots) ? g.characterSlots : [];
      if (!slots.some((s) => s && s.characterId === characterId && s.uid === ctx.uid)) return;
      groupCampaigns(g).forEach((c) => unlocked.add(c));
    });
    if (!unlocked.has(campaignId)) {
      throw new HttpsError('permission-denied', 'Campanha não desbloqueada para este agente.');
    }
  }

  await db.doc(`users/${ctx.uid}/characters/${characterId}`).set({ campaignId }, { merge: true });
  return { success: true, campaignId };
});

// ---------------------------------------------------------------------------
// Notificações push
// ---------------------------------------------------------------------------

const PUSH_TITLE_MAX = 65;
const PUSH_BODY_MAX = 240;
const PUSH_MAX_RECIPIENTS = 500;
const PUSH_MAX_SCHEDULE_DAYS = 90;
const PUSH_HISTORY_LIMIT = 50;
const PUSH_SCREENS = new Set(['player', 'characterSelection']);

const INTEL_TYPE_LABEL = { AUDIO: 'de áudio', TEXT: 'de texto', VISUAL: 'visual' };

/** Agente ativo dentro da pasta, ou null (doc apagado, arquivado ou de outra mesa). */
async function pushCharacter(uid, characterId, wsId) {
  const snap = await getFirestore().doc(`users/${uid}/characters/${characterId}`).get();
  if (!snap.exists) return null;
  const data = snap.data() || {};
  if (data.archived === true || data.workspaceId !== wsId) return null;
  return data;
}

/**
 * Entrega automática para um agente. O texto nunca cita o título do item, que pode
 * ser sigiloso. collapseId faz várias entregas seguidas virarem um aviso só.
 */
async function pushDelivery({ uid, characterId, wsId, category, title, body, data }) {
  const character = await pushCharacter(uid, characterId, wsId);
  if (!character) return;
  const codename = character.codinome || 'Agente';
  const result = await sendToUser(uid, {
    title,
    body: `${codename}: ${body}`,
    category,
    data: { characterId, wsId, screen: 'player', ...data },
    collapseId: `${category}-${characterId}`,
  });
  await logPush(wsId, {
    kind: 'auto',
    category,
    title,
    campaignId: character.campaignId || null,
    recipients: 1,
    sent: result.sent,
    failed: result.failed,
    skipped: result.skipped,
    targetUid: uid,
  });
}

exports.pushOnIntelGranted = onDocumentCreated(
  { document: 'users/{uid}/characters/{characterId}/intel/{intelId}', region: REGION },
  async (event) => {
    const data = event.data?.data();
    if (!data || data.source !== 'admin' || !isId(data.workspaceId)) return;
    const { uid, characterId, intelId } = event.params;
    const typeLabel = INTEL_TYPE_LABEL[data.type];
    await pushDelivery({
      uid,
      characterId,
      wsId: data.workspaceId,
      category: 'intel',
      title: 'TRANSMISSÃO RECEBIDA',
      body: `novo arquivo${typeLabel ? ` ${typeLabel}` : ''} no seu terminal.`,
      data: { intelId },
    });
  },
);

exports.pushOnAchievementGranted = onDocumentCreated(
  { document: 'users/{uid}/characters/{characterId}/achievements/{achievementId}', region: REGION },
  async (event) => {
    const data = event.data?.data();
    if (!data || data.source !== 'admin' || !isId(data.workspaceId)) return;
    const { uid, characterId } = event.params;
    await pushDelivery({
      uid,
      characterId,
      wsId: data.workspaceId,
      category: 'achievements',
      title: 'CONDECORAÇÃO REGISTRADA',
      body: 'nova conquista no seu dossiê.',
      data: { achievementId: data.achievementId },
    });
  },
);

/**
 * SMS de NPC. O cliente marca notifyUid só na primeira fala do NPC em cada diálogo,
 * então um diálogo longo gera um aviso. A regra impede jogador de gravar esse campo.
 */
exports.pushOnNpcMessage = onDocumentCreated(
  { document: 'workspaces/{wsId}/groups/{groupId}/messages/{messageId}', region: REGION },
  async (event) => {
    const data = event.data?.data();
    if (!data || !isId(data.notifyUid) || !isId(data.recipientId) || !data.npcId) return;
    const { wsId, groupId } = event.params;
    await pushDelivery({
      uid: data.notifyUid,
      characterId: data.recipientId,
      wsId,
      category: 'sms',
      title: 'MENSAGEM CRIPTOGRAFADA',
      body: 'novo contato no canal seguro.',
      data: { groupId, threadId: data.dialogueId || data.npcId },
    });
  },
);

function pushText(value, name, max) {
  if (typeof value !== 'string' || value.trim().length === 0 || value.trim().length > max) {
    throw new HttpsError('invalid-argument', `${name} inválido.`);
  }
  return value.trim();
}

function pushScreen(value) {
  return PUSH_SCREENS.has(value) ? value : 'player';
}

/** Primeiro agente de cada conta: o aparelho recebe um aviso por conta. */
function uniqueRecipients(list) {
  const byUid = new Map();
  for (const item of list) {
    if (isId(item?.uid) && !byUid.has(item.uid)) {
      byUid.set(item.uid, { uid: item.uid, characterId: isId(item.characterId) ? item.characterId : null });
    }
  }
  return Array.from(byUid.values());
}

/**
 * Resolve o alvo dentro da pasta, sempre limitado ao acesso do mestre. Co-mestre só
 * alcança as próprias campanhas; a pasta inteira é só do dono.
 * Devolve { recipients, campaignId, label }.
 */
async function resolvePushTarget(wsId, target, access) {
  const db = getFirestore();
  const kind = target?.kind;
  if (kind === 'characters') {
    const items = Array.isArray(target.items) ? target.items : [];
    if (items.length === 0 || items.length > PUSH_MAX_RECIPIENTS) {
      throw new HttpsError('invalid-argument', 'Lista de agentes inválida.');
    }
    const resolved = await Promise.all(items.map(async (item) => {
      requireId(item?.uid, 'uid');
      requireId(item?.characterId, 'characterId');
      const character = await pushCharacter(item.uid, item.characterId, wsId);
      if (!character) throw new HttpsError('not-found', 'Agente não encontrado nesta mesa.');
      const campaigns = characterCampaigns(character);
      if (!accessCoversAny(access, campaigns)) {
        throw new HttpsError('permission-denied', 'Agente fora das suas campanhas.');
      }
      return { character, campaignId: campaigns.find((c) => accessCoversCampaign(access, c)) ?? null };
    }));
    return {
      recipients: uniqueRecipients(items),
      campaignId: resolved[0].campaignId,
      label: items.length === 1 ? resolved[0].character.codinome || items[0].characterId : `${items.length} agentes`,
    };
  }
  if (kind === 'group') {
    requireId(target.groupId, 'groupId');
    const snap = await db.doc(`workspaces/${wsId}/groups/${target.groupId}`).get();
    if (!snap.exists) throw new HttpsError('not-found', 'Esquadrão não encontrado.');
    const group = snap.data() || {};
    const campaigns = groupCampaigns(group);
    if (!accessCoversAny(access, campaigns)) {
      throw new HttpsError('permission-denied', 'Esquadrão fora das suas campanhas.');
    }
    return {
      recipients: uniqueRecipients(Array.isArray(group.characterSlots) ? group.characterSlots : []),
      campaignId: campaigns[0] || null,
      label: group.name || target.groupId,
    };
  }
  if (kind === 'campaign') {
    requireId(target.campaignId, 'campaignId');
    if (!accessCoversCampaign(access, target.campaignId)) {
      throw new HttpsError('permission-denied', 'Sem acesso a esta campanha.');
    }
    const players = await db.collection(`workspaces/${wsId}/players`)
      .where('campaignIds', 'array-contains', target.campaignId).get();
    const recipients = await Promise.all(players.docs.map(async (playerDoc) => {
      const chars = await db.collection(`users/${playerDoc.id}/characters`).where('workspaceId', '==', wsId).get();
      const match = chars.docs.find((d) =>
        d.data()?.archived !== true && characterCampaigns(d.data() || {}).includes(target.campaignId));
      return { uid: playerDoc.id, characterId: match?.id ?? null };
    }));
    return { recipients: uniqueRecipients(recipients), campaignId: target.campaignId, label: target.campaignId };
  }
  if (kind === 'all') {
    if (access.role !== 'owner') {
      throw new HttpsError('permission-denied', 'Apenas o dono envia para a pasta inteira.');
    }
    const players = await db.collection(`workspaces/${wsId}/players`).get();
    return {
      recipients: uniqueRecipients(players.docs.map((d) => {
        const ids = Array.isArray(d.data()?.characterIds) ? d.data().characterIds : [];
        return { uid: d.id, characterId: ids.length === 1 ? ids[0] : null };
      })),
      campaignId: null,
      label: 'all',
    };
  }
  throw new HttpsError('invalid-argument', 'Alvo inválido.');
}

/** Resolve, envia e registra um push de mestre. Devolve os totais do envio. */
async function sendPushToTarget({ wsId, target, access, title, body, screen, category, createdBy, kind }) {
  const resolved = await resolvePushTarget(wsId, target, access);
  if (resolved.recipients.length > PUSH_MAX_RECIPIENTS) {
    throw new HttpsError('resource-exhausted', 'Destinatários demais.');
  }
  const results = await Promise.all(resolved.recipients.map(({ uid, characterId }) => sendToUser(uid, {
    title,
    body,
    category,
    data: { wsId, screen, ...(characterId ? { characterId } : {}) },
  }).catch((err) => {
    console.error('[push] falha ao enviar para conta:', uid, err);
    return { sent: 0, failed: 1, skipped: null };
  })));
  const totals = {
    recipients: resolved.recipients.length,
    sent: results.reduce((sum, r) => sum + r.sent, 0),
    failed: results.reduce((sum, r) => sum + r.failed, 0),
  };
  await logPush(wsId, {
    kind,
    category,
    title,
    body,
    campaignId: resolved.campaignId,
    createdBy,
    targetKind: target.kind,
    targetLabel: resolved.label,
    ...totals,
  });
  return totals;
}

/** Mensagem do mestre, enviada na hora. */
exports.adminSendPush = onCall({ region: REGION }, async (request) => {
  const { wsId, target, title, body, screen } = request.data || {};
  requireId(wsId, 'wsId');
  const access = await assertGm(request, wsId);
  const totals = await sendPushToTarget({
    wsId,
    target,
    access,
    title: pushText(title, 'Título', PUSH_TITLE_MAX),
    body: pushText(body, 'Mensagem', PUSH_BODY_MAX),
    screen: pushScreen(screen),
    category: 'gm',
    createdBy: request.auth.uid,
    kind: 'manual',
  });
  return { success: true, ...totals };
});

/** Agenda um lembrete; o alvo é validado agora e de novo na hora do envio. */
exports.schedulePush = onCall({ region: REGION }, async (request) => {
  const { wsId, target, title, body, screen, sendAt } = request.data || {};
  requireId(wsId, 'wsId');
  const access = await assertGm(request, wsId);
  const when = new Date(sendAt);
  const now = Date.now();
  if (Number.isNaN(when.getTime()) || when.getTime() < now - 60_000
    || when.getTime() > now + PUSH_MAX_SCHEDULE_DAYS * 86_400_000) {
    throw new HttpsError('invalid-argument', 'Data de envio inválida.');
  }
  const resolved = await resolvePushTarget(wsId, target, access);
  const ref = await getFirestore().collection(`workspaces/${wsId}/scheduledPushes`).add({
    sendAt: Timestamp.fromDate(when),
    target,
    title: pushText(title, 'Título', PUSH_TITLE_MAX),
    body: pushText(body, 'Mensagem', PUSH_BODY_MAX),
    screen: pushScreen(screen),
    status: 'pending',
    campaignId: resolved.campaignId,
    targetLabel: resolved.label,
    createdBy: request.auth.uid,
    createdAt: FieldValue.serverTimestamp(),
  });
  return { success: true, id: ref.id };
});

/** Cancela lembrete pendente: o dono cancela qualquer um; o co-mestre, os das suas campanhas. */
exports.cancelScheduledPush = onCall({ region: REGION }, async (request) => {
  const { wsId, id } = request.data || {};
  requireId(wsId, 'wsId');
  requireId(id, 'id');
  const access = await assertGm(request, wsId);
  const ref = getFirestore().doc(`workspaces/${wsId}/scheduledPushes/${id}`);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Lembrete não encontrado.');
  const data = snap.data() || {};
  if (access.role !== 'owner' && !accessCoversCampaign(access, data.campaignId)) {
    throw new HttpsError('permission-denied', 'Lembrete fora das suas campanhas.');
  }
  if (data.status !== 'pending') {
    throw new HttpsError('failed-precondition', 'Lembrete já processado.');
  }
  await ref.update({ status: 'cancelled', cancelledBy: request.auth.uid });
  return { success: true };
});

/** Histórico e lembretes da pasta, filtrados pelo acesso de quem pede. */
exports.listPushActivity = onCall({ region: REGION }, async (request) => {
  const { wsId } = request.data || {};
  requireId(wsId, 'wsId');
  const access = await assertGm(request, wsId);
  const db = getFirestore();
  const [logSnap, scheduledSnap] = await Promise.all([
    db.collection(`workspaces/${wsId}/pushLog`).orderBy('createdAt', 'desc').limit(PUSH_HISTORY_LIMIT).get(),
    db.collection(`workspaces/${wsId}/scheduledPushes`).orderBy('sendAt', 'desc').limit(PUSH_HISTORY_LIMIT).get(),
  ]);
  const visible = (d) => access.role === 'owner' || accessCoversCampaign(access, d.data()?.campaignId);
  return {
    log: logSnap.docs.filter(visible).map((d) => {
      const data = d.data() || {};
      return {
        id: d.id,
        kind: data.kind,
        category: data.category,
        title: data.title,
        body: data.body ?? null,
        targetLabel: data.targetLabel ?? null,
        recipients: data.recipients ?? 0,
        sent: data.sent ?? 0,
        failed: data.failed ?? 0,
        createdAt: toIso(data.createdAt),
      };
    }),
    scheduled: scheduledSnap.docs.filter(visible).map((d) => {
      const data = d.data() || {};
      return {
        id: d.id,
        title: data.title,
        body: data.body,
        targetLabel: data.targetLabel ?? null,
        status: data.status,
        sendAt: toIso(data.sendAt),
      };
    }),
  };
});

/** Marca o lembrete como em envio numa transação: duas execuções nunca mandam o mesmo. */
async function claimScheduledPush(ref) {
  return getFirestore().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists || snap.data()?.status !== 'pending') return null;
    tx.update(ref, { status: 'sending' });
    return snap.data();
  });
}

exports.dispatchScheduledPushes = onSchedule(
  { schedule: 'every 5 minutes', region: REGION, timeZone: 'America/Sao_Paulo' },
  async () => {
    const due = await getFirestore().collectionGroup('scheduledPushes')
      .where('status', '==', 'pending')
      .where('sendAt', '<=', Timestamp.now())
      .limit(200)
      .get();

    await Promise.all(due.docs.map(async (scheduled) => {
      const data = await claimScheduledPush(scheduled.ref);
      if (!data) return;
      const wsId = scheduled.ref.parent.parent.id;
      try {
        // O acesso pode ter mudado desde o agendamento.
        const creator = await getFirestore().doc(`users/${data.createdBy}`).get();
        const access = creator.data()?.suspended === true ? null : await getGmAccess(data.createdBy, wsId);
        if (!access) throw new HttpsError('permission-denied', 'Mestre sem acesso à pasta.');
        const totals = await sendPushToTarget({
          wsId,
          target: data.target,
          access,
          title: data.title,
          body: data.body,
          screen: pushScreen(data.screen),
          category: 'reminders',
          createdBy: data.createdBy,
          kind: 'scheduled',
        });
        await scheduled.ref.update({ status: 'sent', sentAt: FieldValue.serverTimestamp(), ...totals });
      } catch (err) {
        console.error('[push] lembrete falhou:', scheduled.ref.path, err);
        await scheduled.ref.update({ status: 'failed', error: String(err?.message || err).slice(0, 300) });
      }
    }));
  },
);
