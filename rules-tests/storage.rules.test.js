// Testes das regras de Storage (backend/storage.rules), com firestore.get() no emulador.
import { readFileSync } from 'node:fs';
import { after, before, describe, test } from 'node:test';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
} from '@firebase/rules-unit-testing';
import { doc, setDoc } from 'firebase/firestore';
import { getBytes, ref, uploadBytes } from 'firebase/storage';

const A = 'ownerA';
const B = 'ownerB';
const COGM = 'cogmX';
const PLAYER = 'playerX';

let env;

const storage = (persona) =>
  persona === 'legacy'
    ? env.authenticatedContext('legacyAdmin', { admin: true }).storage()
    : env.authenticatedContext(persona).storage();

const audio = new Uint8Array([1, 2, 3]);
const put = (persona, path, contentType = 'audio/mpeg') =>
  uploadBytes(ref(storage(persona), path), audio, { contentType });
const read = (persona, path) => getBytes(ref(storage(persona), path));

before(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-limboos-storage',
    firestore: {
      host: '127.0.0.1',
      port: 8085,
      rules: readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8'),
    },
    storage: {
      host: '127.0.0.1',
      port: 9199,
      rules: readFileSync(new URL('../storage.rules', import.meta.url), 'utf8'),
    },
  });

  await env.withSecurityRulesDisabled(async (ctx) => {
    const d = ctx.firestore();
    await setDoc(doc(d, `workspaces/${A}`), { ownerUid: A, name: 'A' });
    await setDoc(doc(d, `workspaces/${A}/members/${COGM}`), { campaignIds: ['X'] });
    await setDoc(doc(d, `workspaces/${A}/players/${PLAYER}`), { campaignIds: ['X'] });
    const s = ctx.storage();
    await uploadBytes(ref(s, `workspaces/${A}/media/audio/lib.mp3`), audio, { contentType: 'audio/mpeg' });
    await uploadBytes(ref(s, `workspaces/${A}/campaigns/X/media/audio/x.mp3`), audio, { contentType: 'audio/mpeg' });
    await uploadBytes(ref(s, `workspaces/${A}/campaigns/Y/media/audio/y.mp3`), audio, { contentType: 'audio/mpeg' });
    await uploadBytes(ref(s, `workspaces/${A}/npcAvatars/npc.png`), audio, { contentType: 'image/png' });
    await uploadBytes(ref(s, 'media/audio/legado.mp3'), audio, { contentType: 'audio/mpeg' });
  });
});

after(async () => {
  await env?.cleanup();
});

describe('storage multi-tenant', () => {
  test('dono sobe e lê mídia da biblioteca', async () => {
    await assertSucceeds(put(A, `workspaces/${A}/media/audio/nova.mp3`));
    await assertSucceeds(read(A, `workspaces/${A}/media/audio/lib.mp3`));
  });
  test('dono B não lê nem sobe na pasta A', async () => {
    await assertFails(read(B, `workspaces/${A}/media/audio/lib.mp3`));
    await assertFails(read(B, `workspaces/${A}/campaigns/X/media/audio/x.mp3`));
    await assertFails(put(B, `workspaces/${A}/campaigns/X/media/audio/b.mp3`));
  });
  test('co-mestre lê e sobe só na campanha X', async () => {
    await assertSucceeds(read(COGM, `workspaces/${A}/campaigns/X/media/audio/x.mp3`));
    await assertSucceeds(put(COGM, `workspaces/${A}/campaigns/X/media/audio/c.mp3`));
    await assertFails(read(COGM, `workspaces/${A}/campaigns/Y/media/audio/y.mp3`));
    await assertFails(put(COGM, `workspaces/${A}/campaigns/Y/media/audio/c.mp3`));
    await assertFails(read(COGM, `workspaces/${A}/media/audio/lib.mp3`));
  });
  test('tipo de arquivo fora da lista é negado', () =>
    assertFails(put(A, `workspaces/${A}/media/x.exe`, 'application/x-msdownload')));
  test('jogador lê avatar de NPC da pasta, não a mídia', async () => {
    await assertSucceeds(read(PLAYER, `workspaces/${A}/npcAvatars/npc.png`));
    await assertFails(read(PLAYER, `workspaces/${A}/campaigns/X/media/audio/x.mp3`));
  });
  test('legado: claim admin lê, ninguém escreve', async () => {
    await assertSucceeds(read('legacy', 'media/audio/legado.mp3'));
    await assertFails(read(A, 'media/audio/legado.mp3'));
    await assertFails(put('legacy', 'media/audio/novo.mp3'));
  });
});
