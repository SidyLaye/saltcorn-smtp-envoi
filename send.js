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

const Table = require("@saltcorn/data/models/table");
const { getState } = require("@saltcorn/data/db/state");


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
};
