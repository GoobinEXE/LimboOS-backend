const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onDocumentCreated } = require('firebase-functions/v2/firestore');
const { initializeApp } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

initializeApp();

const ADMIN_UID = '5TZK6YHmOOTe5padFPqCbXuavPu1';
const REGION = 'southamerica-east1';

/**
 * adminResetPassword — allows the admin to change any user's password.
 */
exports.adminResetPassword = onCall({ region: REGION }, async (request) => {
  // 1. Verify caller is authenticated
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Autenticação necessária.');
  }

  // 2. Verify caller is the admin (via custom claim or hardcoded UID)
  if (request.auth.token.admin !== true && request.auth.uid !== ADMIN_UID) {
    throw new HttpsError('permission-denied', 'Apenas o administrador pode alterar senhas.');
  }

  const { targetUid, newPassword } = request.data;

  if (!targetUid || typeof targetUid !== 'string') {
    throw new HttpsError('invalid-argument', 'targetUid é obrigatório.');
  }
  if (!newPassword || typeof newPassword !== 'string' || newPassword.length < 6) {
    throw new HttpsError('invalid-argument', 'Senha deve ter no mínimo 6 caracteres.');
  }

  // 3. Prevent admin from changing their own password via this route
  if (targetUid === request.auth.uid) {
    throw new HttpsError(
      'invalid-argument',
      'Use as configurações do seu perfil para alterar sua própria senha.',
    );
  }

  try {
    await getAuth().updateUser(targetUid, { password: newPassword });

    // Log to Firestore for audit trail
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
