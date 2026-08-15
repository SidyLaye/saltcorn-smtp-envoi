/**
 * smtp-envoi V11 — moteur SMTP.
 *
 * - un seul job global à la fois dans le processus Node ;
 * - un sendMail() par destinataire ;
 * - lead, quarantaine et test partagent la même queue ;
 * - pool maxConnections=1 ;
 * - 454/4.3.0 : fermeture transport + cooldown 60 s + 1 retry ;
 * - erreur réseau/4xx transitoire : 1 retry après 5 s ;
 * - journal individuel dans la table notification ;
 * - Nodemailer est chargé paresseusement pour ne jamais faire disparaître
 *   la configuration du plugin si npm install est incomplet.
 */
const Table = require("@saltcorn/data/models/table");

const STATE_KEY = Symbol.for("saltcorn.smtp-envoi.global-state.v4");
const G = globalThis[STATE_KEY] || (globalThis[STATE_KEY] = {
  queue: Promise.resolve(),
  transport: null,
  signature: null,
  cooldownUntil: 0,
  lastSendAt: 0,
});

const MIN_GAP_MS = 1200;
const AUTH_454_COOLDOWN_MS = 60000;
const TRANSIENT_RETRY_MS = 5000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const log = (level, msg) => {
  try {
    const { getState } = require("@saltcorn/data/db/state");
    getState().log(level, `[smtp-envoi] ${msg}`);
  } catch (e) {
    try { console.log(`[smtp-envoi:${level}] ${msg}`); } catch (_) {}
  }
};

let _nodemailer = null;
const getNodemailer = () => {
  if (_nodemailer) return _nodemailer;
  try {
    _nodemailer = require("nodemailer");
    return _nodemailer;
  } catch (e) {
    throw new Error(
      "dépendance nodemailer absente ou non chargeable. " +
      "Vérifiez package.json puis réinstallez/actualisez le plugin. Détail : " +
      (e && e.message ? e.message : String(e))
    );
  }
};

const configSignature = (cfg) => JSON.stringify({
  host: cfg.host || "",
  port: Number(cfg.port || 465),
  tls: cfg.tls !== false,
  username: cfg.username || "",
  password: cfg.password || "",
  from_email: cfg.from_email || "",
  allow_self_signed: !!cfg.allow_self_signed,
});

const makeTransport = (cfg) => {
  const nodemailer = getNodemailer();
  if (!cfg || !cfg.host || !cfg.username || !cfg.password) {
    throw new Error("configuration SMTP incomplète (host/username/password)");
  }
  return nodemailer.createTransport({
    host: cfg.host,
    port: Number(cfg.port || 465),
    secure: cfg.tls !== false,
    auth: { user: cfg.username, pass: cfg.password },
    tls: { rejectUnauthorized: !cfg.allow_self_signed },
    pool: true,
    maxConnections: 1,
    maxMessages: 1000,
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 60000,
  });
};

const closeTransport = async () => {
  const tr = G.transport;
  G.transport = null;
  G.signature = null;
  if (tr) {
    try { tr.close(); } catch (_) {}
  }
};

const getTransport = async (cfg) => {
  const sig = configSignature(cfg);
  if (G.transport && G.signature === sig) return G.transport;
  await closeTransport();
  G.transport = makeTransport(cfg);
  G.signature = sig;
  return G.transport;
};

const enqueue = (fn) => {
  const job = G.queue.then(fn, fn);
  G.queue = job.catch(() => undefined);
  return job;
};

const contexte = (args) => ({
  ...((args && args.row) || {}),
  ...((args && args.context) || {}),
  ...((args && args.extraArgs) || {}),
  ...(args || {}),
});

const normaliser = (input, roleDefaut = "negociateur") => {
  let arr = input;
  if (arr == null) return [];
  if (typeof arr === "string") {
    const s = arr.trim();
    if (!s) return [];
    try {
      const parsed = JSON.parse(s);
      arr = Array.isArray(parsed) ? parsed : s.split(/[;,\n]+/);
    } catch (_) {
      arr = s.split(/[;,\n]+/);
    }
  }
  if (!Array.isArray(arr)) arr = [arr];

  const out = [];
  const vus = new Set();
  for (const x of arr) {
    const obj = typeof x === "object" && x !== null ? x : { email: x };
    const email = String(obj.email || "").trim().toLowerCase();
    if (!email || !email.includes("@") || vus.has(email)) continue;
    vus.add(email);
    out.push({
      email,
      role: obj.role || roleDefaut,
      user_id: obj.user_id ?? null,
    });
  }
  return out;
};

const enTexte = (html) => String(html == null ? "" : html)
  .replace(/<style[\s\S]*?<\/style>/gi, " ")
  .replace(/<script[\s\S]*?<\/script>/gi, " ")
  .replace(/<br\s*\/?\s*>/gi, "\n")
  .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
  .replace(/<li[^>]*>/gi, "- ")
  .replace(/<[^>]+>/g, " ")
  .replace(/&nbsp;/gi, " ")
  .replace(/&amp;/gi, "&")
  .replace(/&lt;/gi, "<")
  .replace(/&gt;/gi, ">")
  .replace(/[ \t]+/g, " ")
  .replace(/\n{3,}/g, "\n\n")
  .trim();

const journaliser = async ({ cfg, leadId, cible, sujet, statut, erreur }) => {
  try {
    const t = Table.findOne({ name: cfg.table_journal || "notification" });
    if (!t) return;
    await t.insertRow({
      lead: leadId || null,
      destinataire: cible.email,
      role: cible.role || null,
      user_id: cible.user_id ?? null,
      objet: sujet || null,
      statut,
      erreur: erreur || null,
      envoye_le: new Date(),
    });
  } catch (e) {
    log(2, `journal SMTP impossible : ${e.message}`);
  }
};

const responseCode = (e) => Number(e && (e.responseCode || e.statusCode));
const errorText = (e) => String((e && (e.response || e.message || e.code)) || e || "");
const is454 = (e) => responseCode(e) === 454 || /\b454\b|4\.3\.0|try again later/i.test(errorText(e));
const isTransient = (e) => {
  const c = responseCode(e);
  return (c >= 400 && c < 500) ||
    /ETIMEDOUT|ECONNRESET|ECONNREFUSED|EPIPE|ESOCKET|ECONNECTION|EAI_AGAIN/i.test(errorText(e));
};

const waitGlobalGuards = async () => {
  const now = Date.now();
  if (G.cooldownUntil > now) await sleep(G.cooldownUntil - now);
  const gap = MIN_GAP_MS - (Date.now() - G.lastSendAt);
  if (gap > 0) await sleep(gap);
};

const sendOneReal = async (cfg, mail) => {
  await waitGlobalGuards();

  const tentative = async () => {
    const tr = await getTransport(cfg);
    const info = await tr.sendMail(mail);
    G.lastSendAt = Date.now();
    return info;
  };

  try {
    return await tentative();
  } catch (e) {
    G.lastSendAt = Date.now();

    if (is454(e)) {
      await closeTransport();
      G.cooldownUntil = Math.max(G.cooldownUntil, Date.now() + AUTH_454_COOLDOWN_MS);
      log(2, `SMTP 454/4.3.0 : cooldown ${AUTH_454_COOLDOWN_MS / 1000}s avant unique retry`);
      await waitGlobalGuards();
      try {
        return await tentative();
      } catch (e2) {
        await closeTransport();
        if (is454(e2)) {
          G.cooldownUntil = Math.max(G.cooldownUntil, Date.now() + AUTH_454_COOLDOWN_MS);
        }
        throw e2;
      }
    }

    if (isTransient(e)) {
      await closeTransport();
      await sleep(TRANSIENT_RETRY_MS);
      try {
        return await tentative();
      } catch (e2) {
        await closeTransport();
        throw e2;
      }
    }

    if (/auth|login|connection|socket/i.test(errorText(e))) await closeTransport();
    throw e;
  }
};

const fromValue = (cfg) => {
  const fromEmail = String(cfg.from_email || cfg.username || "").trim();
  if (!fromEmail) throw new Error("adresse expéditrice SMTP absente");
  const fromNom = String(cfg.from_nom || "").trim();
  return fromNom ? `"${fromNom.replace(/"/g, "'")}" <${fromEmail}>` : fromEmail;
};

const runSend = async ({ cfg, cibles, sujet, corps, leadId, modeTestLocal = false }) => {
  const ciblesNorm = normaliser(cibles);
  const modeTest = cfg.mode_test === true || modeTestLocal === true;
  const redirections = normaliser(cfg.redirection_test || "", "test").map((x) => x.email);

  return enqueue(async () => {
    let nb_envoyes = 0;
    let nb_echecs = 0;
    let nb_simules = 0;
    const erreurs = [];

    if (!ciblesNorm.length) {
      return { nb_envoyes: 0, nb_echecs: 0, nb_simules: 0, erreur_envoi: "aucun destinataire" };
    }

    for (let i = 0; i < ciblesNorm.length; i++) {
      const cible = ciblesNorm[i];

      if (modeTest && redirections.length === 0) {
        await journaliser({ cfg, leadId, cible, sujet, statut: "simule", erreur: null });
        nb_simules++;
        continue;
      }

      const adresseSmtp = modeTest ? redirections[i % redirections.length] : cible.email;
      const mail = {
        from: fromValue(cfg),
        to: adresseSmtp,
        subject: String(sujet || "Nouveau lead"),
        html: String(corps || ""),
        text: enTexte(corps || ""),
        ...(modeTest ? { headers: { "X-Destinataire-Reel": cible.email, "X-Mode-Test": "1" } } : {}),
      };

      try {
        await sendOneReal(cfg, mail);
        await journaliser({
          cfg, leadId, cible, sujet,
          statut: modeTest ? "redirige_test" : "envoye",
          erreur: modeTest ? `redirigé vers ${adresseSmtp}` : null,
        });
        nb_envoyes++;
      } catch (e) {
        const err = errorText(e).slice(0, 1000) || "Erreur SMTP";
        await journaliser({ cfg, leadId, cible, sujet, statut: "echec", erreur: err });
        erreurs.push(`${cible.email}: ${err}`);
        nb_echecs++;
      }
    }

    return {
      nb_envoyes,
      nb_echecs,
      nb_simules,
      erreur_envoi: erreurs.length ? erreurs.join(" | ").slice(0, 3000) : null,
    };
  });
};

const runTest = async (cfg, to, sujet = "Test SMTP Saltcorn", corps = "Test SMTP") => {
  const cible = normaliser([{ email: to, role: "test" }], "test")[0];
  if (!cible) throw new Error("adresse de test invalide");
  // Même queue + même transport + mêmes protections 454 que le flux réel.
  return enqueue(async () => sendOneReal(cfg, {
    from: fromValue(cfg),
    to: cible.email,
    subject: String(sujet || "Test SMTP Saltcorn"),
    html: String(corps || ""),
    text: enTexte(corps || ""),
  }));
};

module.exports = {
  runSend,
  runTest,
  makeTransport,
  normaliser,
  contexte,
  enTexte,
  log,
};
