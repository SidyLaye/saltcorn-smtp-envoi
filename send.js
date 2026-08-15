<<<<<<< HEAD
/**
 * Envoi des messages et journalisation.
 *
 * NOUVEAU FONCTIONNEMENT :
 *
 * - Tous les destinataires d'un lead sont envoyés dans UN SEUL message SMTP.
 * - Les destinataires sont placés en BCC.
 * - Négociateur + secrétaire + custom reçoivent donc le message en même temps.
 * - Les adresses restent invisibles entre elles.
 * - Une ligne de journal est toujours écrite pour CHAQUE destinataire.
 * - Un seul sendMail() est effectué par lead, ce qui évite les délais
 *   successifs et les timeouts du workflow.
 */

=======
const nodemailer = require("nodemailer");
>>>>>>> 2bed734 (update)
const Table = require("@saltcorn/data/models/table");
const db = require("@saltcorn/data/db");

<<<<<<< HEAD

const log = (level, msg) => {
  try {
    getState().log(
      level,
      `[smtp-envoi] ${msg}`
    );
  } catch (e) {
    console.log(
      `[smtp-envoi] ${msg}`
    );
  }
};


/**
 * Transport SMTP.
 *
 * Pool conservé, mais il n'y a désormais qu'un sendMail()
 * pour tous les destinataires d'un lead.
 */
const makeTransport = (cfg) => {

  let nodemailer;

  try {

    nodemailer =
      require("nodemailer");

  } catch (e) {

    throw new Error(
      "nodemailer absent : le module n'a pas installé ses dépendances. "
      + "Désinstallez puis réinstallez smtp-envoi depuis le magasin de modules."
    );
  }


  return nodemailer.createTransport({

    host:
      cfg.host,

    port:
      cfg.port || 465,

    secure:
      cfg.tls !== false,

    auth: {
      user: cfg.username,
      pass: cfg.password
    },

    tls:
      cfg.allow_self_signed
        ? {
            rejectUnauthorized: false
          }
        : undefined,


    /*
     * Pool SMTP.
     *
     * Une seule connexion simultanée.
     *
     * PLUS DE rateDelta / rateLimit :
     * on n'envoie plus 3 messages successifs.
     *
     * Le lead entier = 1 message SMTP.
     */
    pool:
      true,

    maxConnections:
      1,

    maxMessages:
      100,


    connectionTimeout:
      15000,

    greetingTimeout:
      15000,

    socketTimeout:
      20000
  });
};


/**
 * Le contexte Saltcorn peut arriver à plat ou sous row.
 */
const contexte = (args) => ({
  ...(args && args.row ? args.row : {}),
  ...(args || {})
});


/**
 * Normalise les destinataires.
 *
 * Accepte :
 *
 * "a@x.fr,b@y.fr"
 *
 * ["a@x.fr"]
 *
 * [
 *   {
 *     email,
 *     role,
 *     user_id
 *   }
 * ]
 *
 * Une même adresse n'est conservée qu'une fois.
 */
const normaliser = (brut, roleDefaut) => {

  let liste =
    brut;


  if (
    typeof liste === "string"
  ) {

    const t =
      liste.trim();


    if (
      t.startsWith("[")
    ) {

      try {

        liste =
          JSON.parse(t);

      } catch (e) {

        liste =
          t.split(",");
      }

    } else {

      liste =
        t.split(",");
    }
  }


  if (
    !Array.isArray(liste)
  ) {

    return [];
  }


  const vus =
    new Set();


  const sortie =
    [];


  for (
    const d of liste
  ) {

    const o =

      typeof d === "string"

        ? {
            email: d
          }

        : d || {};


    const email =

      String(
        o.email || ""
      )

        .trim()

        .toLowerCase();


    if (
      !email ||
      !email.includes("@") ||
      vus.has(email)
    ) {

      continue;
    }


    vus.add(email);


    sortie.push({

      email,

      role:
        o.role ||
        roleDefaut ||
        "",

      user_id:
        o.user_id != null
          ? o.user_id
          : null
    });
  }


  return sortie;
};


/**
 * Version texte du HTML.
 */
const enTexte = (html) =>

  String(html || "")

    .replace(
      /<style[\s\S]*?<\/style>/gi,
      ""
    )

    .replace(
      /<\/(p|div|li|tr|h[1-6])>/gi,
      "\n"
    )

    .replace(
      /<br\s*\/?>/gi,
      "\n"
    )

    .replace(
      /<li[^>]*>/gi,
      "- "
    )

    .replace(
      /<[^>]+>/g,
      ""
    )

    .replace(
      /&nbsp;/g,
      " "
    )

    .replace(
      /&amp;/g,
      "&"
    )

    .replace(
      /&lt;/g,
      "<"
    )

    .replace(
      /&gt;/g,
      ">"
    )

    .replace(
      /\n{3,}/g,
      "\n\n"
    )

    .trim();


/**
 * Journalisation.
 *
 * Une erreur de journal ne doit jamais
 * transformer un envoi réussi en échec.
 */
const journaliser = async (
  cfg,
  ligne
) => {

  try {

    const t =
      Table.findOne({
        name:
          cfg.table_journal ||
          "notification"
      });


    if (t) {

      await t.insertRow(
        ligne
      );
    }

  } catch (e) {

    log(
      2,
      `journalisation impossible : ${e.message}`
    );
  }
};


/**
 * ENVOI
 *
 * Un seul sendMail() pour tous les destinataires.
 */
const runSend = async ({
  cfg,
  cibles,
  sujet,
  corps,
  leadId,
  modeTestLocal
}) => {


  const maintenant =
    new Date();


  const modeTest =

    cfg.mode_test === true ||

    modeTestLocal === true;


  /*
   * Aucun destinataire.
   */
  if (
    !cibles.length
  ) {

    log(
      3,
      "aucun destinataire — envoi ignoré"
    );


    return {

      nb_envoyes:
        0,

      nb_echecs:
        0,

      erreur_envoi:
        "aucun destinataire"
    };
  }


  /*
   * Redirections de test.
   */
  const redirection =

    String(
      cfg.redirection_test || ""
    )

      .split(",")

      .map(
        (e) =>
          e
            .trim()
            .toLowerCase()
      )

      .filter(
        (e) =>
          e.includes("@")
      );


  /*
   * Déduplication des adresses de test.
   */
  const redirectionUnique =
    [
      ...new Set(
        redirection
      )
    ];


  /*
   * MODE TEST SANS REDIRECTION
   *
   * Aucun SMTP.
   */
  if (
    modeTest &&
    !redirectionUnique.length
  ) {


    for (
      const d of cibles
    ) {

      await journaliser(
        cfg,
        {

          lead:
            leadId || null,

          destinataire:
            d.email,

          role:
            d.role,

          user_id:
            d.user_id,

          objet:
            sujet,

          statut:
            "simule",

          erreur:
            "",

          envoye_le:
            maintenant
        }
      );
    }


    log(
      4,
      `mode test : ${cibles.length} destinataire(s) simulé(s)`
    );


    return {

      nb_envoyes:
        0,

      nb_simules:
        cibles.length,

      erreur_envoi:
        "",

      apercu_destinataires:

        cibles
          .map(
            (d) => d.email
          )
          .join(", ")
    };
  }


  /*
   * Transport.
   */
  let tr;


  try {

    tr =
      makeTransport(cfg);

  } catch (e) {


    log(
      1,
      `transport impossible : ${e.message}`
    );


    /*
     * On journalise également l'échec
     * pour chaque destinataire.
     */
    for (
      const d of cibles
    ) {

      await journaliser(
        cfg,
        {

          lead:
            leadId || null,

          destinataire:
            d.email,

          role:
            d.role,

          user_id:
            d.user_id,

          objet:
            sujet,

          statut:
            "echec",

          erreur:
            `transport SMTP : ${e.message}`,

          envoye_le:
            maintenant
        }
      );
    }


    return {

      nb_envoyes:
        0,

      nb_echecs:
        cibles.length,

      erreur_envoi:
        `transport SMTP : ${e.message}`
    };
  }


  /*
   * Nom d'expéditeur facultatif.
   */
  const expediteur =

    cfg.from_nom &&
    String(
      cfg.from_nom
    ).trim()

      ? {

          name:
            String(
              cfg.from_nom
            ).trim(),

          address:
            cfg.from_email

        }

      : cfg.from_email;


  /*
   * Destination réelle du message SMTP.
   *
   * PRODUCTION :
   * négociateur + secrétaire + custom
   *
   * MODE TEST :
   * uniquement les adresses de redirection.
   */
  const destinatairesSmtp =

    modeTest &&
    redirectionUnique.length

      ? redirectionUnique

      : cibles.map(
          (d) => d.email
        );


  /*
   * Un seul appel SMTP.
   */
  let info =
    null;


  let erreurGlobale =
    "";


  try {


    info =
      await tr.sendMail({

        from:
          expediteur,


        /*
         * Tous les destinataires sont en BCC.
         *
         * Ils reçoivent le mail simultanément
         * sans voir les autres adresses.
         */
        bcc:
          destinatairesSmtp,


        subject:
          sujet ||
          "(sans objet)",


        html:
          corps ||
          "<p>(corps vide)</p>",


        text:
          enTexte(corps) ||
          "(corps vide)",


        /*
         * En mode test seulement.
         */
        ...(modeTest &&
        redirectionUnique.length

          ? {

              headers: {

                "X-Destinataires-Reels":

                  cibles
                    .map(
                      (d) => d.email
                    )
                    .join(",")

              }

            }

          : {})
      });


  } catch (e) {


    erreurGlobale =

      String(
        e && e.message
          ? e.message
          : e
      )

        .slice(
          0,
          400
        );


    log(
      2,
      `échec SMTP groupé : ${erreurGlobale}`
    );
  }


  /*
   * Le transport peut maintenant être fermé :
   * il n'y a qu'un seul message à envoyer.
   */
  try {

    tr.close();

  } catch (e) {

    /* déjà fermé */

  }


  /*
   * Si sendMail a complètement échoué,
   * chaque destinataire réel est journalisé en échec.
   */
  if (
    !info
  ) {


    for (
      const d of cibles
    ) {

      await journaliser(
        cfg,
        {

          lead:
            leadId || null,

          destinataire:
            d.email,

          role:
            d.role,

          user_id:
            d.user_id,

          objet:
            sujet,

          statut:
            "echec",

          erreur:
            erreurGlobale,

          envoye_le:
            maintenant
        }
      );
    }


    log(
      2,
      `envoi terminé : 0 envoyé(s), ${cibles.length} échec(s)`
    );


    return {

      nb_envoyes:
        0,

      nb_echecs:
        cibles.length,

      erreur_envoi:
        erreurGlobale
    };
  }


  /*
   * MODE TEST AVEC REDIRECTION
   *
   * Le message a été accepté par le SMTP
   * vers les adresses de test.
   *
   * On conserve néanmoins le vrai destinataire
   * dans le journal.
   */
  if (
    modeTest &&
    redirectionUnique.length
  ) {


    const destinationTest =
      redirectionUnique.join(", ");


    for (
      const d of cibles
    ) {

      await journaliser(
        cfg,
        {

          lead:
            leadId || null,

          destinataire:
            d.email,

          role:
            d.role,

          user_id:
            d.user_id,

          objet:
            sujet,

          statut:
            "redirige",

          erreur:
            `redirigé vers ${destinationTest}`,

          envoye_le:
            maintenant
        }
      );
    }


    log(
      5,
      `envoi test terminé : ${cibles.length} destinataire(s) représenté(s)`
    );


    return {

      nb_envoyes:
        cibles.length,

      nb_echecs:
        0,

      erreur_envoi:
        ""
    };
  }


  /*
   * PRODUCTION
   *
   * Nodemailer peut retourner les adresses
   * acceptées et rejetées par le serveur SMTP.
   */
  const acceptes =

    new Set(

      (info.accepted || [])

        .map(
          (e) =>
            String(e)
              .trim()
              .toLowerCase()
        )
    );


  const rejetes =

    new Set(

      (info.rejected || [])

        .map(
          (e) =>
            String(e)
              .trim()
              .toLowerCase()
        )
    );


  let envoyes =
    0;


  let echecs =
    0;


  const erreurs =
    [];


  /*
   * Une ligne de journal par destinataire,
   * même si l'envoi SMTP était groupé.
   */
  for (
    const d of cibles
  ) {


    const email =
      String(
        d.email
      )
        .trim()
        .toLowerCase();


    /*
     * Rejet SMTP explicite.
     */
    const estRejete =
      rejetes.has(email);


    /*
     * Si Nodemailer ne remonte pas de liste rejected,
     * un sendMail() réussi est considéré comme envoyé.
     */
    const estAccepte =

      acceptes.has(email) ||

      (
        !rejetes.size &&
        !acceptes.size
      );


    const statut =

      estRejete
        ? "echec"
        : "envoye";


    const erreur =

      estRejete

        ? "adresse rejetée par le serveur SMTP"

        : "";


    if (
      statut === "envoye"
    ) {

      envoyes++;

    } else {

      echecs++;

      erreurs.push(
        `${d.email} → ${erreur}`
      );
    }


    await journaliser(
      cfg,
      {

        lead:
          leadId || null,

        destinataire:
          d.email,

        role:
          d.role,

        user_id:
          d.user_id,

        objet:
          sujet,

        statut,

        erreur,

        envoye_le:
          maintenant
      }
    );
  }


  log(
    5,
    `envoi groupé terminé : ${envoyes} envoyé(s), ${echecs} échec(s)`
  );


  return {

    nb_envoyes:
      envoyes,

    nb_echecs:
      echecs,

    erreur_envoi:
      erreurs.join(" | ")
  };
};


module.exports = {
  runSend,
  makeTransport,
  normaliser,
  contexte,
  enTexte,
  log
=======
const STATE_KEY = Symbol.for("saltcorn.smtp-envoi.global-state.v8");
const G = globalThis[STATE_KEY] || (globalThis[STATE_KEY] = {
  queue: Promise.resolve(),
  transport: null,
  signature: null,
  cooldownUntil: 0,
  lastSendAt: 0,
});

const MIN_GAP_MS = 1500;
const AUTH_454_RETRY_MS = 60000;       // une seule réauthentification après 60 s
const AUTH_454_FINAL_COOLDOWN_MS = 5 * 60 * 1000;
const TRANSIENT_RETRY_MS = 5000;
const PG_LOCK_KEY = 18082026;          // même clé pour TOUS les envois smtp-envoi

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (level, msg) => {
  try { require("@saltcorn/data/models/eventlog").default?.log?.(level, msg); }
  catch (e) { try { console.log(`[smtp-envoi:${level}] ${msg}`); } catch (_) {} }
};

const configSignature = (cfg) => JSON.stringify({
  host: cfg.host || "",
  port: Number(cfg.port || 465),
  tls: cfg.tls !== false,
  username: cfg.username || "",
  password: cfg.password || "",
  allow_self_signed: !!cfg.allow_self_signed,
});

const makeTransport = (cfg) => {
  if (!cfg.host) throw new Error("Serveur SMTP absent");
  if (!cfg.username) throw new Error("Identifiant SMTP absent");
  if (!cfg.password) throw new Error("Mot de passe SMTP absent");

  return nodemailer.createTransport({
    host: String(cfg.host).trim(),
    port: Number(cfg.port || 465),
    secure: cfg.tls !== false,
    auth: { user: String(cfg.username).trim(), pass: String(cfg.password) },
    tls: { rejectUnauthorized: !cfg.allow_self_signed },
    pool: true,
    maxConnections: 1,
    maxMessages: 1000,
    connectionTimeout: 20000,
    greetingTimeout: 20000,
    socketTimeout: 90000,
  });
};

const closeTransport = async () => {
  const tr = G.transport;
  G.transport = null;
  G.signature = null;
  if (tr) try { tr.close(); } catch (e) {}
};

const getTransport = async (cfg) => {
  const sig = configSignature(cfg);
  if (G.transport && G.signature === sig) return G.transport;
  await closeTransport();
  G.transport = makeTransport(cfg);
  G.signature = sig;
  return G.transport;
};

/* File process-wide : lead, quarantaine et tester empruntent tous le même tunnel. */
const enqueue = (fn) => {
  const job = G.queue.then(fn, fn);
  G.queue = job.catch(() => {});
  return job;
};

/*
 * Verrou PostgreSQL inter-processus.
 * Si Saltcorn utilise plusieurs workers/processus, globalThis ne suffit pas.
 * pg_advisory_lock sérialise donc aussi les workers partageant la même base.
 * Sur SQLite ou si getClient n'est pas disponible, la file process-wide reste active.
 */
const withCrossProcessLock = async (fn) => {
  let sqlite = false;
  try { sqlite = typeof db.isSQLite === "function" ? !!db.isSQLite() : !!db.isSQLite; } catch (e) {}
  if (sqlite || typeof db.getClient !== "function") return await fn();

  let client = null;
  let locked = false;
  try {
    try {
      client = await db.getClient();
      if (client && typeof client.query === "function") {
        await client.query("SELECT pg_advisory_lock($1)", [PG_LOCK_KEY]);
        locked = true;
      }
    } catch (lockErr) {
      log(2, `verrou SMTP inter-processus indisponible : ${lockErr.message}`);
    }

    // IMPORTANT : une erreur SMTP venant de fn() remonte telle quelle ;
    // elle ne doit jamais provoquer un second envoi involontaire.
    return await fn();
  } finally {
    if (locked && client) {
      try { await client.query("SELECT pg_advisory_unlock($1)", [PG_LOCK_KEY]); } catch (e) {}
    }
    if (client && typeof client.release === "function") try { client.release(); } catch (e) {}
  }
};

const normaliser = (input, roleDefaut = "negociateur") => {
  let arr = input;
  if (arr == null) return [];
  if (typeof arr === "string") {
    try {
      const parsed = JSON.parse(arr);
      arr = Array.isArray(parsed) ? parsed : arr.split(/[;,\n]+/);
    } catch (e) { arr = arr.split(/[;,\n]+/); }
  }
  if (!Array.isArray(arr)) arr = [arr];

  const out = [];
  const vus = new Set();
  for (const x of arr) {
    const obj = typeof x === "object" && x !== null ? x : { email: x };
    const email = String(obj.email || "").trim().toLowerCase();
    if (!email || !email.includes("@") || vus.has(email)) continue;
    vus.add(email);
    out.push({ email, role: obj.role || roleDefaut, user_id: obj.user_id ?? null });
  }
  return out;
};

const contexte = (args) => ({
  ...(args && args.row ? args.row : {}),
  ...(args && args.context ? args.context : {}),
  ...(args && args.extraArgs ? args.extraArgs : {}),
});

const enTexte = (html) => String(html == null ? "" : html)
  .replace(/<style[\s\S]*?<\/style>/gi, " ")
  .replace(/<script[\s\S]*?<\/script>/gi, " ")
  .replace(/<br\s*\/?\s*>/gi, "\n")
  .replace(/<\/p>/gi, "\n")
  .replace(/<[^>]+>/g, " ")
  .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&")
  .replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
  .replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();

const journaliser = async ({ cfg, leadId, cible, sujet, statut, erreur }) => {
  try {
    const t = Table.findOne({ name: cfg.table_journal || "notification" });
    if (!t) return;
    await t.insertRow({
      lead: leadId || null,
      destinataire: cible.email,
      role: cible.role || null,
      user_id: cible.user_id || null,
      objet: sujet || null,
      statut,
      erreur: erreur || null,
      envoye_le: new Date(),
    });
  } catch (e) { log(2, `journal SMTP impossible : ${e.message}`); }
};

const codeSmtp = (e) => Number(e && (e.responseCode || e.statusCode || 0));
const is454 = (e) => codeSmtp(e) === 454 || /\b454\b|4\.3\.0|try again later/i.test(String(e && (e.response || e.message) || ""));
const isTransient = (e) => {
  const c = codeSmtp(e);
  return (c >= 400 && c < 500) || /ETIMEDOUT|ECONNRESET|ECONNREFUSED|EPIPE|ESOCKET|ECONNECTION|EDNS|ETLS/i.test(String(e && (e.code || e.message) || ""));
};
const detailErreur = (e) => {
  const a = [];
  if (e && e.code) a.push(String(e.code));
  if (e && e.responseCode) a.push(`SMTP ${e.responseCode}`);
  if (e && e.command) a.push(`commande ${e.command}`);
  if (e && e.response) a.push(String(e.response));
  else if (e && e.message) a.push(String(e.message));
  else a.push(String(e));
  return a.join(" — ").slice(0, 900);
};

const waitGap = async () => {
  const gap = MIN_GAP_MS - (Date.now() - G.lastSendAt);
  if (gap > 0) await sleep(gap);
};

const cooldownError = () => {
  const sec = Math.max(1, Math.ceil((G.cooldownUntil - Date.now()) / 1000));
  const e = new Error(`SMTP en refroidissement après 454 — nouvel essai automatique au prochain rejeu (≈${sec}s)`);
  e.code = "SMTP_454_COOLDOWN";
  e.responseCode = 454;
  e.noAttempt = true;
  return e;
};

const sendOneReal = async (cfg, mail) => withCrossProcessLock(async () => {
  // Après un double 454, on n'ouvre surtout PAS une nouvelle session SMTP.
  if (G.cooldownUntil > Date.now()) throw cooldownError();
  await waitGap();

  const tentative = async () => {
    const tr = await getTransport(cfg);
    try {
      const info = await tr.sendMail(mail);
      G.lastSendAt = Date.now();
      return info;
    } catch (e) {
      G.lastSendAt = Date.now();
      throw e;
    }
  };

  try {
    return await tentative();
  } catch (e) {
    if (is454(e)) {
      /*
       * 454 4.3.0 est temporaire. Une seule réauthentification après 60 s,
       * verrou global conservé : aucun autre lead/quarantaine/test ne peut
       * démarrer entre les deux tentatives.
       */
      await closeTransport();
      log(2, `SMTP 454 : pause ${AUTH_454_RETRY_MS / 1000}s avant UNE réauthentification`);
      await sleep(AUTH_454_RETRY_MS);
      try {
        const info = await tentative();
        G.cooldownUntil = 0;
        return info;
      } catch (e2) {
        await closeTransport();
        if (is454(e2)) {
          G.cooldownUntil = Date.now() + AUTH_454_FINAL_COOLDOWN_MS;
          e2.final454 = true;
          log(2, `SMTP 454 persistant : aucun nouvel AUTH pendant ${AUTH_454_FINAL_COOLDOWN_MS / 60000} min dans ce processus`);
        }
        throw e2;
      }
    }

    if (isTransient(e)) {
      await closeTransport();
      await sleep(TRANSIENT_RETRY_MS);
      try { return await tentative(); }
      catch (e2) { await closeTransport(); throw e2; }
    }

    if (/auth|login|connection|socket/i.test(String(e.message || ""))) await closeTransport();
    throw e;
  }
});

const runSend = async ({ cfg, cibles, sujet, corps, leadId, modeTestLocal = false }) => {
  const ciblesNorm = normaliser(cibles);
  const modeTest = cfg.mode_test === true || modeTestLocal === true;
  const redirections = normaliser(cfg.redirection_test || "", "test").map((x) => x.email);

  return enqueue(async () => {
    let nb_envoyes = 0;
    let nb_echecs = 0;
    const erreurs = [];

    for (let i = 0; i < ciblesNorm.length; i++) {
      const cible = ciblesNorm[i];

      if (modeTest && redirections.length === 0) {
        await journaliser({ cfg, leadId, cible, sujet, statut: "simule", erreur: null });
        nb_envoyes++;
        continue;
      }

      const adresseReelle = modeTest ? redirections[i % redirections.length] : cible.email;
      const fromEmail = String(cfg.from_email || cfg.username || "").trim();
      const fromNom = String(cfg.from_nom || "").trim();
      if (!fromEmail) throw new Error("Adresse expéditrice SMTP absente");
      const from = fromNom ? `"${fromNom.replace(/"/g, "'")}" <${fromEmail}>` : fromEmail;

      const mail = {
        from,
        to: adresseReelle,
        subject: String(sujet || "Nouveau lead"),
        html: String(corps || ""),
        text: enTexte(corps || ""),
      };

      try {
        await sendOneReal(cfg, mail);
        await journaliser({
          cfg, leadId, cible, sujet,
          statut: modeTest ? "redirige_test" : "envoye",
          erreur: modeTest ? `redirigé vers ${adresseReelle}` : null,
        });
        nb_envoyes++;
      } catch (e) {
        const err = detailErreur(e);
        await journaliser({ cfg, leadId, cible, sujet, statut: "echec", erreur: err });
        erreurs.push(`${cible.email}: ${err}`);
        nb_echecs++;

        /* Après un 454 persistant/cooldown, NE PAS essayer les destinataires
         * suivants : ce serait uniquement refaire LOGIN et aggraver le blocage.
         * Ils sont journalisés comme échecs et seront repris par IMAP-IDLE. */
        if (is454(e) || e.noAttempt || e.final454) {
          for (let j = i + 1; j < ciblesNorm.length; j++) {
            const reste = ciblesNorm[j];
            const msg = "SMTP non tenté : tunnel suspendu après 454 4.3.0 — rejeu automatique";
            await journaliser({ cfg, leadId, cible: reste, sujet, statut: "echec", erreur: msg });
            erreurs.push(`${reste.email}: ${msg}`);
            nb_echecs++;
          }
          break;
        }
      }
    }

    return {
      nb_envoyes,
      nb_echecs,
      erreur_envoi: erreurs.length ? erreurs.join(" | ").slice(0, 3000) : null,
      smtp_cooldown: G.cooldownUntil > Date.now(),
    };
  });
};

const runTest = async (cfg, to, subject, html) => enqueue(async () => {
  const cible = String(to || "").trim();
  if (!cible || !cible.includes("@")) throw new Error("adresse de test invalide");
  const fromEmail = String(cfg.from_email || cfg.username || "").trim();
  const fromNom = String(cfg.from_nom || "").trim();
  const from = fromNom ? `"${fromNom.replace(/"/g, "'")}" <${fromEmail}>` : fromEmail;
  return await sendOneReal(cfg, {
    from, to: cible, subject: subject || "Test SMTP",
    html: html || "<p>Test SMTP</p>", text: enTexte(html || "Test SMTP")
  });
});

module.exports = {
  runSend, runTest, makeTransport, normaliser, contexte, enTexte, log,
  detailErreur, is454
>>>>>>> 2bed734 (update)
};
