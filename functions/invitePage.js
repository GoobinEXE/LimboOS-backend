// Página de /convite/** servida pela Function invitePage (rewrite do Hosting).
//
// Devolve o index.html do app com a prévia de link (og/twitter/<title>) trocada pelo
// nome da mesa quando o token é válido. Clientes de chat e bots de grupo copiam e
// guardam essa prévia, então ela revela menos que a tela do convite:
// - só o nome da mesa; nunca a missão, o tipo de convite, o dono, jogadores ou vagas;
// - token inexistente, expirado, revogado ou esgotado recebe a mesma prévia genérica,
//   byte a byte, para a página não servir de oráculo de validade;
// - o token só aparece no og:url do convite válido (a URL que o remetente já
//   compartilhou); a página genérica não tem og:url nem canonical; token e hash
//   nunca vão para o log;
// - noindex e Cache-Control: no-store; se a leitura do Firestore falhar, sai a prévia
//   genérica e o app abre do mesmo jeito.
const { getFirestore } = require('firebase-admin/firestore');

const DEFAULT_SITE_ORIGIN = 'https://limboos.web.app';
// Sem janela de cache: um index.html guardado de antes de um deploy aponta para
// /assets/* que o Hosting já não serve (404) e o app não abre. Cada pedido revalida
// por ETag (304 barato); a cópia guardada só serve de reserva se o Hosting falhar.
const INDEX_TTL_MS = 0;
const INDEX_FETCH_TIMEOUT_MS = 3000;
const FIRESTORE_TIMEOUT_MS = 4000;
const MAX_NAME_LENGTH = 48;
const TOKEN_RE = /^[A-Za-z0-9_-]{10,64}$/;
const HOST_RE = /^[a-z0-9.-]+(?::\d{1,5})?$/;
const ROBOTS = 'noindex, nofollow';

/** Textos da prévia (provisórios; ver docs/qol/textos/A6-backend.json). */
const INVITE_COPY = {
  valid: {
    title: (mesa) => `Convite para a mesa ${mesa}`,
    description: 'Um lugar na mesa espera por você. Abra o link no aparelho para aceitar o convite.',
  },
  generic: {
    title: 'LimboOS | Convite',
    description: 'Abra o link no aparelho para ver o convite do terminal dos agentes.',
  },
};

/** Sem o shell do app não há o que servir: o navegador tenta de novo sozinho. */
const RETRY_HTML = `<!doctype html>
<html lang="pt-BR">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="robots" content="${ROBOTS}" />
    <meta http-equiv="refresh" content="5" />
    <title>LimboOS</title>
  </head>
  <body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#090A0C;color:#8F9397;font-family:ui-monospace,'Courier New',monospace;font-size:12px;letter-spacing:0.2em;text-transform:uppercase">
    <p>Sem sinal com o terminal. Tentando de novo...</p>
  </body>
</html>
`;

let fetchImpl = (...args) => fetch(...args);
let indexTtlMs = INDEX_TTL_MS;
/** @type {{ origin: string, html: string, etag: string | null, fetchedAt: number } | null} */
let indexCache = null;

/** Troca o fetch do index.html e o TTL do cache, e limpa o cache (só nos testes). */
function configureInvitePageForTests({ fetch: fakeFetch, indexTtlMs: ttl } = {}) {
  fetchImpl = fakeFetch || ((...args) => fetch(...args));
  indexTtlMs = typeof ttl === 'number' ? ttl : INDEX_TTL_MS;
  indexCache = null;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`tempo esgotado (${ms} ms)`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function isEmulator() {
  return process.env.FUNCTIONS_EMULATOR === 'true';
}

/** Origem que a pessoa abriu (domínio próprio, web.app ou firebaseapp.com). */
function publicOrigin(req) {
  const headers = req.headers || {};
  const host = String(headers['x-forwarded-host'] || headers.host || '')
    .split(',')[0].trim().toLowerCase();
  if (!HOST_RE.test(host)) return DEFAULT_SITE_ORIGIN;
  return `${isEmulator() ? 'http' : 'https'}://${host}`;
}

/** De onde vem o index.html. Fixo em produção para o Host da requisição não virar proxy. */
function shellOrigin(req) {
  const configured = process.env.INVITE_SITE_ORIGIN;
  if (configured) return configured.replace(/\/+$/, '');
  if (isEmulator()) return publicOrigin(req);
  return DEFAULT_SITE_ORIGIN;
}

/**
 * index.html do Hosting, revalidado por ETag a cada pedido (o build troca os hashes
 * dos assets a cada deploy). Se a busca falhar, usa a cópia antiga, se houver.
 */
async function loadIndexHtml(origin) {
  const cached = indexCache && indexCache.origin === origin ? indexCache : null;
  if (cached && Date.now() - cached.fetchedAt < indexTtlMs) return cached.html;
  try {
    const headers = cached?.etag ? { 'If-None-Match': cached.etag } : {};
    const res = await fetchImpl(`${origin}/index.html`, {
      headers,
      signal: AbortSignal.timeout(INDEX_FETCH_TIMEOUT_MS),
    });
    if (res.status === 304 && cached) {
      cached.fetchedAt = Date.now();
      return cached.html;
    }
    if (!res.ok) throw new Error(`index.html respondeu ${res.status}`);
    const html = await res.text();
    if (!/<\/head>/i.test(html)) throw new Error('index.html sem </head>');
    indexCache = { origin, html, etag: res.headers.get('etag'), fetchedAt: Date.now() };
    return html;
  } catch (err) {
    console.warn('[invitePage] index.html indisponível:', err?.message || err);
    return cached ? cached.html : null;
  }
}

/** Token do path /convite/:token, no formato que createInvite gera. */
function tokenFromPath(path) {
  const parts = String(path || '').split('?')[0].split('/').filter(Boolean);
  if (parts.length !== 2 || parts[0] !== 'convite') return null;
  let token;
  try {
    token = decodeURIComponent(parts[1]);
  } catch {
    return null;
  }
  return TOKEN_RE.test(token) ? token : null;
}

function cleanName(value) {
  if (typeof value !== 'string') return null;
  const name = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!name) return null;
  const chars = Array.from(name);
  return chars.length > MAX_NAME_LENGTH
    ? `${chars.slice(0, MAX_NAME_LENGTH - 1).join('').trimEnd()}…`
    : name;
}

function metaPattern(attr, key) {
  return new RegExp(`[ \\t]*<meta\\b[^>]*\\b${attr}=["']${key}["'][^>]*>[ \\t]*\\r?\\n?`, 'gi');
}

/** Substitui (ou insere antes de </head>) a meta tag; o valor sai escapado. */
function upsertMeta(html, attr, key, value) {
  const tag = `<meta ${attr}="${key}" content="${escapeHtml(value)}" />`;
  const pattern = metaPattern(attr, key);
  let replaced = false;
  // Função como substituto: "$&" ou "$'" no nome da mesa não podem virar padrão.
  const out = html.replace(pattern, (match) => {
    if (replaced) return '';
    replaced = true;
    const indent = /^[ \t]*/.exec(match)[0];
    return `${indent}${tag}${match.endsWith('\n') ? '\n' : ''}`;
  });
  return replaced ? out : out.replace(/<\/head>/i, () => `  ${tag}\n  </head>`);
}

function removeMeta(html, attr, key) {
  return html.replace(metaPattern(attr, key), '');
}

/** Aplica a prévia ao shell do app. `url` nulo tira o og:url (prévia genérica). */
function renderPreview(shell, { title, description, url }) {
  let html = shell.replace(/<title>[\s\S]*?<\/title>/i, () => `<title>${escapeHtml(title)}</title>`);
  html = html.replace(/[ \t]*<link\b[^>]*\brel=["']canonical["'][^>]*>[ \t]*\r?\n?/gi, '');
  html = upsertMeta(html, 'name', 'robots', ROBOTS);
  html = upsertMeta(html, 'name', 'description', description);
  html = upsertMeta(html, 'property', 'og:title', title);
  html = upsertMeta(html, 'property', 'og:description', description);
  html = upsertMeta(html, 'name', 'twitter:title', title);
  html = upsertMeta(html, 'name', 'twitter:description', description);
  html = url ? upsertMeta(html, 'property', 'og:url', url) : removeMeta(html, 'property', 'og:url');
  return html;
}

/**
 * Cria o handler HTTP. Recebe hashToken e inviteStatus de index.js para validar o
 * token pelas mesmas regras de getInvitePreview e acceptInvite.
 */
function createInvitePageHandler({ hashToken, inviteStatus }) {
  async function workspaceNameFor(token) {
    try {
      const db = getFirestore();
      const snap = await withTimeout(db.doc(`invites/${hashToken(token)}`).get(), FIRESTORE_TIMEOUT_MS);
      const invite = snap.exists ? snap.data() : null;
      if (inviteStatus(invite) !== 'valid') return null;
      const wsId = invite.wsId;
      if (typeof wsId !== 'string' || !wsId || wsId.includes('/')) return null;
      const wsSnap = await withTimeout(db.doc(`workspaces/${wsId}`).get(), FIRESTORE_TIMEOUT_MS);
      return cleanName(wsSnap.exists ? wsSnap.data()?.name : null);
    } catch (err) {
      console.error('[invitePage] leitura do convite falhou:', err?.code || err?.message || err);
      return null;
    }
  }

  return async function invitePageHandler(req, res) {
    res.set('Cache-Control', 'no-store');
    res.set('X-Robots-Tag', ROBOTS);
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.set('Allow', 'GET, HEAD');
      res.status(405).send('');
      return;
    }

    const shell = await loadIndexHtml(shellOrigin(req));
    res.set('Content-Type', 'text/html; charset=utf-8');
    if (!shell) {
      res.set('Retry-After', '5');
      res.status(503).send(RETRY_HTML);
      return;
    }

    const token = tokenFromPath(req.path ?? req.url);
    const name = token ? await workspaceNameFor(token) : null;
    const html = name
      ? renderPreview(shell, {
        title: INVITE_COPY.valid.title(name),
        description: INVITE_COPY.valid.description,
        url: `${publicOrigin(req)}/convite/${token}`,
      })
      : renderPreview(shell, { ...INVITE_COPY.generic, url: null });
    res.status(200).send(html);
  };
}

module.exports = {
  createInvitePageHandler,
  configureInvitePageForTests,
  renderPreview,
  escapeHtml,
  INVITE_COPY,
  DEFAULT_SITE_ORIGIN,
};
