// Testes da página /convite/** (prévia de link) contra o emulador do Firestore,
// com o index.html do Hosting falso.
// Rodar: cd backend/rules-tests && npm run test:functions
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-limboos-fn';
process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8085';

const crypto = require('node:crypto');
const { after, beforeEach, describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fft = require('firebase-functions-test')({ projectId: process.env.GCLOUD_PROJECT });
const fns = require('../index.js');
const invitePage = require('../invitePage.js');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');

const db = getFirestore();
const A = 'ownerA';
const SITE = invitePage.DEFAULT_SITE_ORIGIN;

const SHELL = `<!doctype html>
<html lang="pt-BR">
  <head>
    <meta charset="UTF-8" />
    <title>LimboOS | Terminal dos agentes</title>
    <meta name="description" content="Companion app de RPG de mesa." />
    <link rel="canonical" href="${SITE}/" />
    <meta property="og:type" content="website" />
    <meta property="og:site_name" content="LimboOS" />
    <meta property="og:url" content="${SITE}/" />
    <meta property="og:title" content="LimboOS | Terminal dos agentes" />
    <meta property="og:description" content="Aparelho oficial dos agentes." />
    <meta property="og:image" content="${SITE}/og-image.png" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="LimboOS | Terminal dos agentes" />
    <meta name="twitter:description" content="Aparelho oficial dos agentes." />
    <script type="module" crossorigin src="/assets/index-abc123.js"></script>
  </head>
  <body><div id="root"></div></body>
</html>
`;

let fetchCalls = [];
let shellResponder = () => new Response(SHELL, { status: 200, headers: { etag: '"v1"' } });

function useShell(options = {}) {
  fetchCalls = [];
  invitePage.configureInvitePageForTests({
    fetch: async (url, init) => {
      fetchCalls.push({ url, headers: init?.headers || {} });
      return shellResponder(url, init);
    },
    ...options,
  });
}

function call(fn, uid, data) {
  return fft.wrap(fn)({ data, auth: uid ? { uid, token: {} } : undefined, rawRequest: {} });
}

function fakeResponse() {
  return {
    statusCode: 200,
    headers: {},
    body: undefined,
    headersSent: false,
    status(code) { this.statusCode = code; return this; },
    set(key, value) { this.headers[key.toLowerCase()] = value; return this; },
    send(body) { this.body = body; this.headersSent = true; return this; },
  };
}

async function get(path, { handler = fns.invitePage, host = 'limboos.web.app', method = 'GET' } = {}) {
  const req = { method, path, url: path, headers: { host: 'invitepage.run.app', 'x-forwarded-host': host } };
  const res = fakeResponse();
  await handler(req, res);
  return res;
}

function metaContent(html, attr, key) {
  const m = new RegExp(`<meta ${attr}="${key}" content="([^"]*)" />`).exec(html);
  return m ? m[1] : null;
}

async function createInvite(kind = 'player') {
  return call(fns.createInvite, A, { wsId: A, kind, campaignId: 'X' });
}

async function clearDb() {
  const res = await fetch(
    `http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${process.env.GCLOUD_PROJECT}/databases/(default)/documents`,
    { method: 'DELETE' },
  );
  assert.ok(res.ok, 'falha ao limpar o emulador');
}

beforeEach(async () => {
  await clearDb();
  await db.doc(`users/${A}`).set({ uid: A, masterName: 'mestreA' });
  await db.doc(`workspaces/${A}`).set({ ownerUid: A, name: 'Pasta A' });
  await db.doc(`workspaces/${A}/campaigns/X`).set({ name: 'Campanha Secreta' });
  shellResponder = () => new Response(SHELL, { status: 200, headers: { etag: '"v1"' } });
  useShell();
});

after(() => {
  invitePage.configureInvitePageForTests();
  fft.cleanup();
});

describe('página do convite', () => {
  test('token válido mostra só o nome da mesa, com og:url da própria URL e sem canonical', async () => {
    const { token, inviteId } = await createInvite('cogm');
    const res = await get(`/convite/${token}`);
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.equal(res.headers['x-robots-tag'], 'noindex, nofollow');
    assert.match(res.headers['content-type'], /^text\/html/);

    const html = res.body;
    for (const [attr, key] of [['property', 'og:title'], ['name', 'twitter:title']]) {
      assert.equal(metaContent(html, attr, key), 'Convite para a mesa Pasta A');
    }
    assert.match(html, /<title>Convite para a mesa Pasta A<\/title>/);
    assert.equal(metaContent(html, 'property', 'og:description'), invitePage.INVITE_COPY.valid.description);
    assert.equal(metaContent(html, 'name', 'twitter:description'), invitePage.INVITE_COPY.valid.description);
    assert.equal(metaContent(html, 'property', 'og:url'), `https://limboos.web.app/convite/${token}`);
    assert.equal(metaContent(html, 'name', 'robots'), 'noindex, nofollow');
    assert.doesNotMatch(html, /rel="canonical"/);
    assert.equal((html.match(/property="og:title"/g) || []).length, 1);
    // O shell do app segue intacto para a SPA hidratar.
    assert.match(html, /<script type="module" crossorigin src="\/assets\/index-abc123\.js"><\/script>/);
    assert.match(html, /<div id="root"><\/div>/);

    // Nada de missão, tipo de convite, dono ou hash.
    assert.ok(!html.includes('Campanha Secreta'));
    assert.ok(!html.includes(A));
    assert.ok(!html.includes(inviteId));
    assert.ok(!/co-?mestre|cogm/i.test(html));
    assert.equal(html.split(token).length - 1, 1, 'o token só aparece no og:url');

    assert.equal(fetchCalls[0].url, `${SITE}/index.html`);
  });

  test('convite de jogador e de co-mestre geram a mesma prévia', async () => {
    const player = await createInvite('player');
    const cogm = await createInvite('cogm');
    const a = (await get(`/convite/${player.token}`)).body.replace(player.token, 'T');
    const b = (await get(`/convite/${cogm.token}`)).body.replace(cogm.token, 'T');
    assert.equal(a, b);
  });

  test('nome da mesa sai escapado', async () => {
    await db.doc(`workspaces/${A}`).update({ name: `Mesa "><script>alert('x')</script> & $& $'` });
    const { token } = await createInvite();
    const html = (await get(`/convite/${token}`)).body;
    assert.ok(!html.includes('<script>alert'));
    const escaped = 'Convite para a mesa Mesa &quot;&gt;&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt; &amp; $&amp; $&#39;';
    assert.equal(metaContent(html, 'property', 'og:title'), escaped);
    assert.equal(metaContent(html, 'name', 'twitter:title'), escaped);
    assert.ok(html.includes(`<title>${escaped}</title>`));
  });

  test('inexistente, malformado, expirado, revogado e esgotado devolvem a mesma prévia genérica', async () => {
    const expired = await createInvite();
    await db.doc(`invites/${expired.inviteId}`).update({ expiresAt: Timestamp.fromMillis(Date.now() - 1000) });
    const revoked = await createInvite();
    await call(fns.revokeInvite, A, { wsId: A, inviteId: revoked.inviteId });
    const exhausted = await createInvite('cogm');
    await db.doc(`invites/${exhausted.inviteId}`).update({ uses: 1 });

    const paths = [
      `/convite/${crypto.randomBytes(16).toString('base64url')}`,
      '/convite/curto',
      `/convite/${'x'.repeat(65)}`,
      '/convite/%E0%A4%A',
      '/convite',
      `/convite/${expired.token}`,
      `/convite/${revoked.token}`,
      `/convite/${exhausted.token}`,
    ];
    const bodies = [];
    for (const path of paths) {
      const res = await get(path);
      assert.equal(res.statusCode, 200, path);
      assert.equal(res.headers['cache-control'], 'no-store');
      bodies.push(res.body);
    }
    for (const body of bodies.slice(1)) assert.equal(body, bodies[0]);

    const html = bodies[0];
    assert.equal(metaContent(html, 'property', 'og:title'), invitePage.INVITE_COPY.generic.title);
    assert.equal(metaContent(html, 'name', 'twitter:title'), invitePage.INVITE_COPY.generic.title);
    assert.equal(metaContent(html, 'property', 'og:description'), invitePage.INVITE_COPY.generic.description);
    assert.equal(metaContent(html, 'name', 'robots'), 'noindex, nofollow');
    assert.doesNotMatch(html, /og:url|rel="canonical"/);
    assert.ok(!html.includes('Pasta A'));
    assert.ok(!/expirad|revogad|esgotad|inválid/i.test(html));
  });

  test('falha na leitura do convite cai na prévia genérica', async () => {
    const { token } = await createInvite();
    const generic = (await get('/convite/qualquer-token-falso')).body;
    const broken = invitePage.createInvitePageHandler({
      hashToken: () => { throw new Error('firestore fora do ar'); },
      inviteStatus: () => 'valid',
    });
    const res = await get(`/convite/${token}`, { handler: broken });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body, generic);
  });

  test('index.html fica em cache curto, revalida por ETag e usa a cópia antiga se o Hosting falhar', async () => {
    useShell({ indexTtlMs: 0 });
    const { token } = await createInvite();
    await get(`/convite/${token}`);
    shellResponder = () => new Response(null, { status: 304 });
    const second = await get(`/convite/${token}`);
    assert.equal(fetchCalls.length, 2);
    assert.equal(fetchCalls[1].headers['If-None-Match'], '"v1"');
    assert.equal(metaContent(second.body, 'property', 'og:title'), 'Convite para a mesa Pasta A');

    shellResponder = () => { throw new TypeError('fetch failed'); };
    const third = await get(`/convite/${token}`);
    assert.equal(third.statusCode, 200);
    assert.equal(metaContent(third.body, 'property', 'og:title'), 'Convite para a mesa Pasta A');

    shellResponder = () => new Response(SHELL, { status: 200, headers: { etag: '"v2"' } });
    useShell({ indexTtlMs: 60_000 });
    await get(`/convite/${token}`);
    await get(`/convite/${token}`);
    assert.equal(fetchCalls.length, 1, 'dentro do TTL não busca de novo');
  });

  test('sem index.html nenhum, pede para o navegador tentar de novo', async () => {
    shellResponder = () => new Response('erro', { status: 500 });
    const res = await get('/convite/qualquer-token-falso');
    assert.equal(res.statusCode, 503);
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.equal(res.headers['retry-after'], '5');
    assert.match(res.body, /http-equiv="refresh"/);
    assert.match(res.body, /name="robots" content="noindex, nofollow"/);
  });

  test('host inválido no cabeçalho cai na origem padrão e método diferente de GET é recusado', async () => {
    const { token } = await createInvite();
    const res = await get(`/convite/${token}`, { host: 'evil.com"><x' });
    assert.equal(metaContent(res.body, 'property', 'og:url'), `${SITE}/convite/${token}`);
    const post = await get(`/convite/${token}`, { method: 'POST' });
    assert.equal(post.statusCode, 405);
  });
});
