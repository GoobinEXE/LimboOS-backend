#!/usr/bin/env node
/**
 * Migração para o modelo multi-tenant: copia os dados globais atuais (de um único
 * mestre) para workspaces/{ownerUid}. Idempotente: pode rodar de novo, regrava com
 * merge. Não apaga as coleções antigas (elas ficam só leitura pelas regras novas).
 *
 * Uso:
 *   node backend/scripts/migrate-to-workspaces.cjs --owner-uid=<uid> [--apply]
 *   node backend/scripts/migrate-to-workspaces.cjs --owner-email=gm.mpg@limboos.local --apply --grant-platform-admin
 *
 * Opções:
 *   --apply                 grava (sem ela, só simula e mostra as contagens)
 *   --owner-uid / --owner-email   dono da pasta (os dados atuais são dele)
 *   --workspace-name="..."  nome da pasta (padrão: "Pasta do mestre")
 *   --skip-logs             não copia activityLog
 *   --grant-platform-admin  aplica o claim platformAdmin ao dono (mantém o claim admin legado)
 *
 * Credenciais: GOOGLE_APPLICATION_CREDENTIALS (service account) ou, no emulador,
 * FIRESTORE_EMULATOR_HOST / FIREBASE_AUTH_EMULATOR_HOST + GCLOUD_PROJECT.
 * Antes de rodar em produção: gcloud firestore export gs://<bucket>/backup-pre-multitenant
 */
const path = require('node:path');
const fs = require('node:fs');

const { createRequire } = require('node:module');

// Usa o firebase-admin já instalado em backend/functions.
const functionsRequire = createRequire(path.join(__dirname, '..', 'functions', 'package.json'));
const { initializeApp, applicationDefault, getApps } = functionsRequire('firebase-admin/app');
const { getFirestore, FieldValue } = functionsRequire('firebase-admin/firestore');
const { getAuth } = functionsRequire('firebase-admin/auth');

// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {};
  for (const raw of argv) {
    if (!raw.startsWith('--')) continue;
    const [k, ...rest] = raw.slice(2).split('=');
    args[k] = rest.length ? rest.join('=') : true;
  }
  return args;
}

const LEGACY_SEED_DIR = path.join(__dirname, 'legacy-seed');
const ALL_FEATURES = { bios: true, limbo: true, win95: true, terminal: true, mac: true, diskRepair: true };
const BATCH_LIMIT = 400;

function readSeed(name) {
  const file = path.join(LEGACY_SEED_DIR, `${name}.json`);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
}

function uniq(values) {
  return Array.from(new Set(values.filter((v) => typeof v === 'string' && v)));
}

/** 'global' ou lista → campos do Firestore novo. */
function listScope(campaignIds) {
  if (campaignIds === 'global' || campaignIds == null) return { campaignIds: [], global: true };
  return { campaignIds: Array.isArray(campaignIds) ? campaignIds : [], global: false };
}

class Writer {
  constructor(db, apply) {
    this.db = db;
    this.apply = apply;
    this.batch = db.batch();
    this.pending = 0;
    this.total = 0;
    this.counts = {};
  }
  async set(ref, data, label) {
    this.counts[label] = (this.counts[label] || 0) + 1;
    this.total += 1;
    if (!this.apply) return;
    this.batch.set(ref, data, { merge: true });
    this.pending += 1;
    if (this.pending >= BATCH_LIMIT) await this.flush();
  }
  async flush() {
    if (!this.apply || this.pending === 0) return;
    await this.batch.commit();
    this.batch = this.db.batch();
    this.pending = 0;
  }
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const apply = args.apply === true;

  if (!getApps().length) {
    const useEmulator = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
    initializeApp(useEmulator ? { projectId: process.env.GCLOUD_PROJECT } : { credential: applicationDefault() });
  }
  const db = getFirestore();

  let ownerUid = typeof args['owner-uid'] === 'string' ? args['owner-uid'] : null;
  if (!ownerUid && typeof args['owner-email'] === 'string') {
    ownerUid = (await getAuth().getUserByEmail(args['owner-email'])).uid;
  }
  if (!ownerUid) {
    console.error('Informe --owner-uid=<uid> ou --owner-email=<email>.');
    process.exit(1);
  }
  const ws = ownerUid;
  const W = (...p) => db.doc(['workspaces', ws, ...p].join('/'));
  const wr = new Writer(db, apply);
  const log = (...m) => console.log(apply ? '[apply]' : '[simulação]', ...m);
  log(`Pasta de destino: workspaces/${ws}`);

  // 1. Pasta
  const wsSnap = await db.doc(`workspaces/${ws}`).get();
  if (!wsSnap.exists) {
    await wr.set(db.doc(`workspaces/${ws}`), {
      ownerUid: ws,
      name: typeof args['workspace-name'] === 'string' ? args['workspace-name'] : 'Pasta do mestre',
      createdAt: FieldValue.serverTimestamp(),
    }, 'workspace');
  }
  const workspaceName = wsSnap.exists ? wsSnap.data().name : (args['workspace-name'] || 'Pasta do mestre');

  const catalogState = (await db.doc('system/catalogState').get()).data() || {};
  const get = async (name) => (await db.collection(name).get()).docs;

  // 2. Campanhas (com todos os mini-apps ligados: era o comportamento de antes)
  let campaigns = await get('campaigns');
  const campaignRows = campaigns.map((d) => ({ id: d.id, data: d.data() }));
  if (campaignRows.length === 0 && !catalogState.campaigns?.initialized) {
    readSeed('campaigns').forEach((c) => campaignRows.push({ id: c.id, data: c }));
    log(`Sem campanhas no Firestore: usando o seed legado (${campaignRows.length}).`);
  }
  for (const { id, data } of campaignRows) {
    await wr.set(W('campaigns', id), { ...data, features: { ...ALL_FEATURES, ...(data.features || {}) } }, 'campaigns');
  }
  const campaignIds = campaignRows.map((c) => c.id);

  // 3. Estado de sessão global → estado de cada campanha
  const limbo = (await db.doc('system/limboState').get()).data() || {};
  const gameEvents = (await db.doc('system/gameEvents').get()).data() || {};
  for (const id of campaignIds) {
    await wr.set(W('campaigns', id, 'state', 'live'), {
      seized: limbo.seized === true,
      seizedBy: limbo.seizedBy ?? null,
      seizedAt: limbo.seizedAt ?? null,
      readThreadIds: Array.isArray(limbo.readThreadIds) ? limbo.readThreadIds : [],
      diskRepairAllowed: gameEvents.diskRepairAllowed === true,
    }, 'campaignState');
  }
  const campaignSettings = (await db.doc('system/campaignSettings').get()).data();
  if (campaignSettings) await wr.set(W('config', 'settings'), campaignSettings, 'config');
  const analytics = (await db.doc('system/analytics').get()).data();
  if (analytics) await wr.set(W('stats', 'analytics'), analytics, 'stats');

  // 4. Biblioteca
  const assets = await get('mediaAssets');
  const assetCampaign = new Map();
  for (const d of assets) {
    const data = d.data();
    assetCampaign.set(d.id, data.campaignId ?? null);
    await wr.set(W('mediaAssets', d.id), { ...data, campaignId: data.campaignId ?? null }, 'mediaAssets');
  }
  for (const d of await get('mediaFolders')) {
    await wr.set(W('mediaFolders', d.id), { ...d.data(), campaignId: d.data().campaignId ?? null }, 'mediaFolders');
  }

  let achievementRows = (await get('achievementDefs')).map((d) => ({ id: d.id, data: d.data() }));
  if (achievementRows.length === 0 && !catalogState.achievements?.initialized) {
    achievementRows = readSeed('achievements').map((a) => ({ id: a.id, data: a }));
    log(`Sem conquistas no Firestore: usando o seed legado (${achievementRows.length}).`);
  }
  for (const { id, data } of achievementRows) {
    await wr.set(W('achievementDefs', id), { ...data, ...listScope(data.campaignIds) }, 'achievementDefs');
  }

  let contactRows = (await get('npcContacts')).map((d) => ({ id: d.id, data: d.data() }));
  let dialogueRows = (await get('npcDialogues')).map((d) => ({ id: d.id, data: d.data() }));
  if (contactRows.length === 0 && !catalogState.npcSms?.initialized) {
    contactRows = readSeed('npcContacts').map((c) => ({ id: c.id, data: c }));
    dialogueRows = readSeed('npcDialogues').map((c) => ({ id: c.id, data: c }));
    log(`Sem NPCs no Firestore: usando o seed legado (${contactRows.length} contatos).`);
  }
  const contactScope = new Map();
  for (const { id, data } of contactRows) {
    const scope = listScope(data.campaignIds);
    contactScope.set(id, scope);
    await wr.set(W('npcContacts', id), { ...data, ...scope }, 'npcContacts');
  }
  for (const { id, data } of dialogueRows) {
    await wr.set(W('npcDialogues', id), { ...data, ...(contactScope.get(data.npcId) || listScope('global')) }, 'npcDialogues');
  }

  for (const d of await get('jukeboxTracks')) {
    await wr.set(W('jukeboxTracks', d.id), { ...d.data(), campaignIds: [], global: true }, 'jukeboxTracks');
  }
  for (const d of await get('qrRedirects')) {
    const data = d.data();
    await wr.set(W('qrRedirects', d.id), { ...data, campaignId: assetCampaign.get(data.targetId) ?? null }, 'qrRedirects');
  }

  // 5. Esquadrões (+ mensagens)
  const groups = await get('groups');
  const groupRows = [];
  for (const g of groups) {
    const data = g.data();
    const slots = Array.isArray(data.characterSlots) ? data.characterSlots : [];
    const memberUids = uniq(slots.map((s) => s && s.uid));
    const gCampaigns = uniq([data.campaignId, ...(data.unlockedCampaigns || [])]);
    groupRows.push({ id: g.id, slots, campaigns: gCampaigns });
    await wr.set(W('groups', g.id), { ...data, memberUids, campaignIds: gCampaigns }, 'groups');
    for (const m of (await g.ref.collection('messages').get()).docs) {
      await wr.set(W('groups', g.id, 'messages', m.id), m.data(), 'groupMessages');
    }
  }

  // 6. Jogadores: agentes ganham a pasta; flags de conta passam ao agente; roster e índice.
  const users = await get('users');
  const charCampaignByKey = new Map();
  for (const u of users) {
    const account = u.data() || {};
    // Agente que já pertence a outra pasta (mesa criada depois do multi-tenant) fica
    // onde está: rodar a migração de novo não pode puxá-lo para a pasta do dono.
    const chars = (await u.ref.collection('characters').get()).docs.filter((c) => {
      const owner = c.data()?.workspaceId;
      if (owner && owner !== ws) {
        wr.counts.skippedForeignCharacters = (wr.counts.skippedForeignCharacters || 0) + 1;
        return false;
      }
      return true;
    });
    if (chars.length === 0) continue;
    const rosterCampaigns = new Set();
    const characterIds = [];
    for (const c of chars) {
      const data = c.data() || {};
      const archived = data.archived === true;
      if (!archived) characterIds.push(c.id);
      charCampaignByKey.set(`${u.id}_${c.id}`, data.campaignId ?? null);
      const flags = {};
      if (account.hasTerminalAccess === true && data.hasTerminalAccess === undefined) flags.hasTerminalAccess = true;
      if (account.hasMacAccess === true && data.hasMacAccess === undefined) flags.hasMacAccess = true;
      if (account.notes && !data.notes) flags.notes = account.notes;
      await wr.set(c.ref, { workspaceId: ws, ...flags }, 'characters');
      if (!archived) {
        uniq([data.campaignId, ...(data.unlockedCampaigns || [])]).forEach((x) => rosterCampaigns.add(x));
        groupRows
          .filter((g) => g.slots.some((s) => s && s.uid === u.id && s.characterId === c.id))
          .forEach((g) => g.campaigns.forEach((x) => rosterCampaigns.add(x)));
      }
      for (const i of (await c.ref.collection('intel').get()).docs) {
        await wr.set(i.ref, { workspaceId: ws }, 'intelUnlocks');
      }
      for (const a of (await c.ref.collection('achievements').get()).docs) {
        await wr.set(a.ref, { workspaceId: ws }, 'achievementGrants');
      }
    }
    await wr.set(W('players', u.id), {
      uid: u.id,
      displayName: account.displayName || account.masterName || null,
      masterName: account.masterName || null,
      characterIds,
      campaignIds: Array.from(rosterCampaigns).sort(),
      status: 'active',
      joinedAt: account.createdAt ?? FieldValue.serverTimestamp(),
      lastLogin: account.lastLogin ?? null,
      suspended: account.suspended === true,
      ...(account.notes ? { notes: account.notes } : {}),
    }, 'players');
    await wr.set(db.doc(`users/${u.id}/memberships/${ws}`), {
      wsId: ws,
      workspaceName,
      isPlayer: true,
      updatedAt: FieldValue.serverTimestamp(),
    }, 'memberships');
  }

  // 7. Eventos de reprodução e log
  for (const d of await get('playEvents')) {
    const data = d.data();
    await wr.set(W('playEvents', d.id), {
      ...data,
      campaignId: data.campaignId ?? charCampaignByKey.get(`${data.uid}_${data.characterId}`) ?? null,
    }, 'playEvents');
  }
  if (args['skip-logs'] !== true) {
    for (const d of await get('activityLog')) {
      await wr.set(W('activityLog', d.id), { ...d.data(), campaignId: d.data().campaignId ?? null }, 'activityLog');
    }
  }

  await wr.flush();

  // 8. Claim de admin da plataforma (mantém o admin legado para leitura das coleções antigas)
  if (args['grant-platform-admin'] === true) {
    const user = await getAuth().getUser(ws);
    const claims = { ...(user.customClaims || {}), platformAdmin: true };
    if (apply) await getAuth().setCustomUserClaims(ws, claims);
    log(`Claim platformAdmin ${apply ? 'aplicado' : 'seria aplicado'} em ${ws}.`);
  }

  log('Contagens:', JSON.stringify(wr.counts, null, 2));
  log(`Total de escritas ${apply ? 'feitas' : 'previstas'}: ${wr.total}`);
  if (!apply) log('Nada foi gravado. Rode de novo com --apply.');
  return { counts: wr.counts, total: wr.total };
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { main };
