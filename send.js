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

const Table = require("@saltcorn/data/models/table");
const { getState } = require("@saltcorn/data/db/state");

const log = (level, msg) => {
  try {
    getState().log(level, `[smtp-envoi] ${msg}`);
  } catch (e) {
    console.log(`[smtp-envoi] ${msg}`);
  }
};


/**
 * Construit un transport nodemailer depuis la configuration du plugin.
 */
const makeTransport = (cfg) => {

  let nodemailer;

  try {
    nodemailer = require("nodemailer");
  } catch (e) {

    throw new Error(
      "nodemailer absent : le module n'a pas installé ses dépendances. "
      + "Désinstallez puis réinstallez smtp-envoi depuis le magasin de modules."
    );
  }


  return nodemailer.createTransport({

    host: cfg.host,

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
     * POOL SMTP
     *
     * Une seule connexion SMTP est utilisée.
     *
     * Maximum :
     * 1 message toutes les 10 secondes.
     *
     * La logique métier ne change pas.
     */
    pool: true,

    maxConnections: 1,

    maxMessages: 100,

    rateDelta: 10000,

    rateLimit: 1,


    /*
     * Timeouts
     */
    connectionTimeout: 15000,

    greetingTimeout: 15000,

    socketTimeout: 20000
  });
};


/**
 * Le contexte d'une étape de workflow peut arriver à plat ou sous `row`.
 */
const contexte = (args) => ({
  ...(args && args.row ? args.row : {}),
  ...(args || {})
});


/**
 * Normalise les destinataires.
 *
 * Formes acceptées :
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
 */
const normaliser = (brut, roleDefaut) => {

  let liste = brut;


  if (typeof liste === "string") {

    const t =
      liste.trim();


    if (t.startsWith("[")) {

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


  if (!Array.isArray(liste)) {
    return [];
  }


  const vus =
    new Set();


  const sortie =
    [];


  for (const d of liste) {

    const o =
      typeof d === "string"
        ? {
            email: d
          }
        : d || {};


    const email =
      String(o.email || "")
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
 * Version texte d'un corps HTML.
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
 * Écrit une ligne dans `notification`.
 * N'échoue jamais bruyamment.
 */
const journaliser = async (cfg, ligne) => {

  try {

    const t =
      Table.findOne({
        name:
          cfg.table_journal ||
          "notification"
      });


    if (t) {
      await t.insertRow(ligne);
    }

  } catch (e) {

    log(
      2,
      `journalisation impossible : ${e.message}`
    );
  }
};


/**
 * Une passe d'envoi.
 *
 * Ne lève jamais.
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


  if (!cibles.length) {

    log(
      3,
      "aucun destinataire — envoi ignoré"
    );


    return {
      nb_envoyes: 0,
      nb_echecs: 0,
      erreur_envoi: "aucun destinataire"
    };
  }


  /*
   * Adresses de redirection test.
   */
  const redirection =

    String(
      cfg.redirection_test || ""
    )

      .split(",")

      .map(
        (e) =>
          e.trim().toLowerCase()
      )

      .filter(
        (e) =>
          e.includes("@")
      );


  /*
   * MODE TEST SANS REDIRECTION
   *
   * Rien ne part.
   */
  if (
    modeTest &&
    !redirection.length
  ) {


    for (const d of cibles) {

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

      nb_envoyes: 0,

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
   * TRANSPORT SMTP
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


    return {

      nb_envoyes:
        0,

      erreur_envoi:
        `transport SMTP : ${e.message}`
    };
  }


  let envoyes =
    0;


  const echecs =
    [];


  cibles.forEach(
    (d, i) => {
      d._rang = i;
    }
  );


  /*
   * UN ENVOI PAR DESTINATAIRE
   *
   * Cette logique reste inchangée.
   */
  for (const d of cibles) {


    const redirige =
      modeTest &&
      redirection.length > 0;


    const destination =

      redirige

        ? redirection[
            d._rang %
            redirection.length
          ]

        : d.email;


    let statut =
      "echec";


    let erreur =
      "";


    try {


      /*
       * NOM D'EXPÉDITEUR FACULTATIF
       *
       * Si cfg.from_nom est vide :
       *
       * From: adresse@email.fr
       *
       * Si un nom existe :
       *
       * From: Nom <adresse@email.fr>
       */
      const expediteur =

        cfg.from_nom &&
        String(cfg.from_nom).trim()

          ? {

              name:
                String(
                  cfg.from_nom
                ).trim(),

              address:
                cfg.from_email

            }

          : cfg.from_email;


      await tr.sendMail({

        from:
          expediteur,

        to:
          destination,

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
         * Seulement en redirection de test.
         */
        ...(redirige

          ? {

              headers: {

                "X-Destinataire-Reel":
                  d.email,

                "X-Role-Destinataire":
                  d.role || ""
              }

            }

          : {})
      });


      statut =
        redirige
          ? "redirige"
          : "envoye";


      envoyes++;


    } catch (e) {


      erreur =
        String(
          e && e.message
            ? e.message
            : e
        )
          .slice(
            0,
            400
          );


      echecs.push(
        `${destination} → ${erreur}`
      );


      log(
        2,
        `échec vers ${destination} : ${erreur}`
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

        erreur:

          erreur ||

          (
            redirige

              ? `redirigé vers ${destination}`

              : ""
          ),

        envoye_le:
          maintenant
      }
    );
  }


  try {

    tr.close();

  } catch (e) {

    /* transport déjà fermé */

  }


  log(
    5,
    `envoi terminé : ${envoyes} envoyé(s), ${echecs.length} échec(s)`
  );


  return {

    nb_envoyes:
      envoyes,

    nb_echecs:
      echecs.length,

    erreur_envoi:
      echecs.join(" | ")
  };
};


module.exports = {
  runSend,
  makeTransport,
  normaliser,
  contexte,
  enTexte,
  log
};
