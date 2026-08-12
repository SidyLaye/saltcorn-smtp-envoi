/**
 * Envoi des messages et journalisation.
 *
 * Trois garanties, chacune couvrant une défaillance que les autres ne couvrent pas :
 *
 *   1. Un envoi par destinataire — et non un envoi groupé. Un échec sur une
 *                                  adresse n'emporte pas les autres, et deux
 *                                  agences ne découvrent pas mutuellement
 *                                  leurs adresses.
 *   2. Aucune exception propagée  — un échec rend `erreur_envoi` et laisse le
 *                                  workflow poursuivre. Le run 516 s'est arrêté
 *                                  sur une erreur d'e-mail : `maj_lead` n'a
 *                                  jamais tourné et le lead est resté incomplet.
 *                                  C'est le défaut que ce module corrige.
 *   3. Journal systématique       — une ligne dans `notification` pour CHAQUE
 *                                  destinataire, y compris en mode test et y
 *                                  compris en échec. Sans quoi le tableau de
 *                                  bord ne peut pas répondre à « ce négociateur
 *                                  a-t-il été prévenu, et quand ».
 */
const nodemailer = require("nodemailer");
const Table = require("@saltcorn/data/models/table");
const { getState } = require("@saltcorn/data/db/state");

const log = (level, msg) => {
  try {
    getState().log(level, `[smtp-envoi] ${msg}`);
  } catch (e) {
    console.log(`[smtp-envoi] ${msg}`);
  }
};

/** Construit un transport nodemailer depuis la configuration du plugin. */
const makeTransport = (cfg) =>
  nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port || 465,
    secure: cfg.tls !== false,
    auth: { user: cfg.username, pass: cfg.password },
    tls: cfg.allow_self_signed ? { rejectUnauthorized: false } : undefined,
    // Sans ces délais, un serveur muet fait pendre la requête indéfiniment —
    // exactement le symptôme rencontré sur « Send test email » avec Zimbra.
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 20000,
  });

/**
 * Le contexte d'une étape de workflow peut arriver à plat ou sous `row`.
 * On fusionne les deux plutôt que de parier sur l'un.
 */
const contexte = (args) => ({ ...(args && args.row ? args.row : {}), ...(args || {}) });

/**
 * Normalise les destinataires. Trois formes acceptées :
 *   "a@x.fr,b@y.fr" · ["a@x.fr"] · [{ email, role, user_id }]
 *
 * ★ Le dédoublonnage n'est pas cosmétique : une même personne peut être
 *   négociateur sur un lead et secrétaire sur un autre. Elle ne doit recevoir
 *   qu'un seul message.
 */
const normaliser = (brut, roleDefaut) => {
  let liste = brut;
  if (typeof liste === "string") {
    const t = liste.trim();
    if (t.startsWith("[")) {
      try { liste = JSON.parse(t); } catch (e) { liste = t.split(","); }
    } else liste = t.split(",");
  }
  if (!Array.isArray(liste)) return [];

  const vus = new Set();
  const sortie = [];
  for (const d of liste) {
    const o = typeof d === "string" ? { email: d } : d || {};
    const email = String(o.email || "").trim().toLowerCase();
    if (!email || !email.includes("@") || vus.has(email)) continue;
    vus.add(email);
    sortie.push({
      email,
      role: o.role || roleDefaut || "",
      user_id: o.user_id != null ? o.user_id : null,
    });
  }
  return sortie;
};

/** Écrit une ligne dans `notification`. N'échoue jamais bruyamment. */
const journaliser = async (cfg, ligne) => {
  try {
    const t = Table.findOne({ name: cfg.table_journal || "notification" });
    if (t) await t.insertRow(ligne);
  } catch (e) {
    // Un envoi réussi ne doit pas être rapporté en échec parce que le journal
    // a fauté.
    log(2, `journalisation impossible : ${e.message}`);
  }
};

/**
 * Une passe d'envoi. Ne lève jamais.
 * Retourne toujours un objet exploitable comme contexte de workflow.
 */
const runSend = async ({ cfg, cibles, sujet, corps, leadId, modeTestLocal }) => {
  const maintenant = new Date();
  const modeTest = cfg.mode_test === true || modeTestLocal === true;

  if (!cibles.length) {
    log(3, "aucun destinataire — envoi ignoré");
    return { nb_envoyes: 0, nb_echecs: 0, erreur_envoi: "aucun destinataire" };
  }

  // ── Mode test : on journalise, on n'envoie rien ────────────────────
  if (modeTest) {
    for (const d of cibles)
      await journaliser(cfg, {
        lead: leadId || null, destinataire: d.email, role: d.role,
        user_id: d.user_id, objet: sujet, statut: "simule",
        erreur: "", envoye_le: maintenant,
      });
    log(4, `mode test : ${cibles.length} destinataire(s) simulé(s)`);
    return {
      nb_envoyes: 0,
      nb_simules: cibles.length,
      erreur_envoi: "",
      apercu_destinataires: cibles.map((d) => d.email).join(", "),
    };
  }

  let tr;
  try {
    tr = makeTransport(cfg);
  } catch (e) {
    log(1, `transport impossible : ${e.message}`);
    return { nb_envoyes: 0, erreur_envoi: `transport SMTP : ${e.message}` };
  }

  let envoyes = 0;
  const echecs = [];

  for (const d of cibles) {
    let statut = "echec";
    let erreur = "";
    try {
      await tr.sendMail({
        from: { name: cfg.from_nom || "Pipeline", address: cfg.from_email },
        to: d.email,
        subject: sujet || "(sans objet)",
        html: corps || "<p>(corps vide)</p>",
      });
      statut = "envoye";
      envoyes++;
    } catch (e) {
      erreur = String(e && e.message ? e.message : e).slice(0, 400);
      echecs.push(`${d.email} → ${erreur}`);
      log(2, `échec vers ${d.email} : ${erreur}`);
    }
    await journaliser(cfg, {
      lead: leadId || null, destinataire: d.email, role: d.role,
      user_id: d.user_id, objet: sujet, statut, erreur, envoye_le: maintenant,
    });
  }

  try { tr.close(); } catch (e) { /* transport déjà fermé */ }

  log(5, `envoi terminé : ${envoyes} envoyé(s), ${echecs.length} échec(s)`);
  return { nb_envoyes: envoyes, nb_echecs: echecs.length, erreur_envoi: echecs.join(" | ") };
};

module.exports = { runSend, makeTransport, normaliser, contexte, log };
