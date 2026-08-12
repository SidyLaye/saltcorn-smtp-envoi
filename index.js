/**
 * smtp-envoi — envoi d'e-mails pour le pipeline de leads.
 *
 * Pendant de `imap-idle` : l'un relève, l'autre notifie. Mêmes conventions.
 *
 * Pourquoi un plugin plutôt que `run_js_code` :
 *   Le bac à sable de `run_js_code` n'expose pas `require` — donc pas de
 *   nodemailer, donc pas de SMTP. Un plugin s'exécute dans le vrai processus
 *   Node : le SMTP OVH est joignable en direct, sans passer par un service
 *   tiers. Les données de prospects ne sortent pas de votre infrastructure.
 *
 * Pourquoi le corps du message ne se videra plus :
 *   L'action native `send_email` perd son champ « body » à l'enregistrement du
 *   formulaire. Ici la configuration d'une action ne contient QUE DES NOMS DE
 *   VARIABLES — chaînes courtes. Le texte du message n'est jamais saisi dans un
 *   formulaire : il vient du contexte, produit par le nœud `notifier`.
 */
const Workflow = require("@saltcorn/data/models/workflow");
const Form = require("@saltcorn/data/models/form");
const Table = require("@saltcorn/data/models/table");

const { runSend, makeTransport, normaliser, contexte, log } = require("./send");

// ── Configuration ────────────────────────────────────────────────────
const configuration_workflow = () =>
  new Workflow({
    steps: [
      {
        name: "Serveur SMTP",
        form: () =>
          new Form({
            blurb:
              "OVH mutualisé : ssl0.ovh.net, port 465, TLS coché. "
            + "OVH Exchange : ex.mail.ovh.net. "
            + "L'identifiant est l'adresse e-mail COMPLÈTE — c'est l'erreur "
            + "la plus fréquente.",
            fields: [
              { name: "host", label: "Serveur SMTP", type: "String", required: true,
                default: "ssl0.ovh.net",
                sublabel: "Nom du serveur seul, sans https:// ni port" },
              { name: "port", label: "Port", type: "Integer", default: 465,
                sublabel: "465 avec TLS coché, ou 587 décoché (STARTTLS)" },
              { name: "tls", label: "TLS", type: "Bool", default: true,
                sublabel: "À cocher avec le port 465" },
              { name: "username", label: "Identifiant", type: "String", required: true,
                sublabel: "L'adresse complète, ex. pipeline@ambs-agency.com" },
              { name: "password", label: "Mot de passe", type: "String",
                input_type: "password", required: true,
                sublabel: "⚠ stocké en base : à prendre en compte côté RGPD" },
              { name: "from_email", label: "Adresse expéditrice", type: "String",
                required: true,
                sublabel: "OVH rejette un expéditeur différent du compte "
                        + "authentifié — mettez la même adresse que l'identifiant" },
              { name: "from_nom", label: "Nom affiché", type: "String",
                default: "Pipeline Sélection Habitat" },
              { name: "allow_self_signed", label: "Accepter un certificat auto-signé",
                type: "Bool", default: false },
            ],
          }),
      },
      {
        name: "Journal et mode test",
        form: async () => {
          const tables = await Table.find({}, { cached: true });
          return new Form({
            fields: [
              { name: "table_journal", label: "Table de journalisation",
                input_type: "select", required: true,
                options: tables.map((t) => t.name),
                sublabel: "Attendue : `notification`. Colonnes utilisées : lead, "
                        + "destinataire, role, user_id, objet, statut, erreur, envoye_le" },
              { name: "mode_test", label: "MODE TEST — ne rien envoyer",
                type: "Bool", default: true,
                sublabel: "Coché : les destinataires sont journalisés avec le statut "
                        + "« simule », mais aucun message ne part. "
                        + "★ Interrupteur général : un seul endroit pour tout couper, "
                        + "sans rouvrir le workflow." },
            ],
          });
        },
      },
    ],
  });

module.exports = {
  sc_plugin_api_version: 1,
  configuration_workflow,

  actions: (cfg) => ({

    // ── 1. Notification des négociateurs ─────────────────────────────
    // Les valeurs par défaut correspondent aux variables produites par le
    // nœud `notifier`. Il n'y a normalement rien à saisir.
    smtp_envoi_lead: {
      configFields: [
        { name: "cle_destinataires", label: "Variable — destinataires",
          type: "String", default: "destinataires_prevus",
          sublabel: "Tableau [{email, role, user_id}], ou liste d'adresses" },
        { name: "cle_sujet", label: "Variable — objet",
          type: "String", default: "sujet" },
        { name: "cle_corps", label: "Variable — corps HTML",
          type: "String", default: "corpsMail" },
        { name: "cle_lead", label: "Variable — id du lead",
          type: "String", default: "lead",
          sublabel: "Pour rattacher les lignes du journal" },
        { name: "cle_mode_test", label: "Variable — mode test local",
          type: "String", default: "mode_test",
          sublabel: "Vide pour ne dépendre que de l'interrupteur général" },
        { name: "role_defaut", label: "Rôle par défaut",
          type: "String", default: "negociateur",
          sublabel: "Utilisé si les destinataires sont de simples adresses" },
      ],
      run: async (args) => {
        try {
          const ctx = contexte(args);
          const c = args.configuration || {};
          return await runSend({
            cfg,
            cibles: normaliser(
              ctx[c.cle_destinataires || "destinataires_prevus"],
              c.role_defaut || "negociateur"
            ),
            sujet: ctx[c.cle_sujet || "sujet"] || "Nouveau lead",
            corps: ctx[c.cle_corps || "corpsMail"],
            leadId: ctx[c.cle_lead || "lead"],
            modeTestLocal: c.cle_mode_test ? ctx[c.cle_mode_test] === true : false,
          });
        } catch (e) {
          log(1, `exception dans smtp_envoi_lead : ${e.message}`);
          return { nb_envoyes: 0, erreur_envoi: `exception : ${e.message}` };
        }
      },
    },

    // ── 2. Alerte quarantaine ────────────────────────────────────────
    // Les destinataires viennent de `destinataire_custom` (portee = "tous"),
    // pas du contexte : en quarantaine le bien n'a pas été retrouvé, donc
    // aucun négociateur n'est connu.
    smtp_envoi_quarantaine: {
      configFields: [
        { name: "cle_motif", label: "Variable — motif",
          type: "String", default: "motif_quarantaine" },
        { name: "cle_email_id", label: "Variable — id e-mail source",
          type: "String", default: "email_id" },
        { name: "cle_reference", label: "Variable — référence extraite",
          type: "String", default: "reference" },
        { name: "cle_mode_test", label: "Variable — mode test local",
          type: "String", default: "mode_test" },
      ],
      run: async (args) => {
        try {
          const ctx = contexte(args);
          const c = args.configuration || {};

          const motif = ctx[c.cle_motif || "motif_quarantaine"] || "non précisé";
          const emailId = ctx[c.cle_email_id || "email_id"] || "?";
          const ref = ctx[c.cle_reference || "reference"] || "";

          const tDest = Table.findOne({ name: "destinataire_custom" });
          const rows = tDest
            ? await tDest.getRows({ portee: "tous", actif: true })
            : [];

          return await runSend({
            cfg,
            cibles: normaliser(rows.map((r) => r.email), "quarantaine"),
            sujet: `[QUARANTAINE] e-mail ${emailId} — ${motif}`,
            corps:
              `<p>Un e-mail n'a pas pu être traité automatiquement.</p><ul>`
            + `<li><b>Motif :</b> ${motif}</li>`
            + `<li><b>Référence extraite :</b> ${ref || "(aucune)"}</li>`
            + `<li><b>E-mail source :</b> ${emailId}</li></ul>`
            + `<p><b>Aucune écriture n'a été faite dans Immofacile.</b> `
            + `Ce lead doit être traité à la main.</p>`,
            leadId: null,
            modeTestLocal: c.cle_mode_test ? ctx[c.cle_mode_test] === true : false,
          });
        } catch (e) {
          log(1, `exception dans smtp_envoi_quarantaine : ${e.message}`);
          return { nb_envoyes: 0, erreur_envoi: `exception : ${e.message}` };
        }
      },
    },

    // ── 3. Test de connexion ─────────────────────────────────────────
    // ★ Ignore volontairement le mode test : c'est toute sa raison d'être.
    //   `verify()` avant l'envoi sépare un problème de connexion d'un
    //   problème d'authentification — le « Send test email » natif, lui,
    //   se contente de pendre.
    smtp_tester: {
      configFields: [
        { name: "adresse_test", label: "Envoyer à", type: "String", required: true,
          sublabel: "Une adresse que vous relevez vous-même" },
      ],
      run: async (args) => {
        const dest = (args.configuration || {}).adresse_test;
        try {
          const tr = makeTransport(cfg);
          await tr.verify();
          await tr.sendMail({
            from: { name: cfg.from_nom || "Pipeline", address: cfg.from_email },
            to: dest,
            subject: "Test SMTP — pipeline Sélection Habitat",
            html: "<p>Si vous lisez ceci, l'envoi fonctionne.</p>",
          });
          try { tr.close(); } catch (e) {}
          log(4, `test SMTP réussi vers ${dest}`);
          return { notify: `✔ Envoyé à ${dest}. Vérifiez aussi le dossier spam.` };
        } catch (e) {
          log(2, `test SMTP en échec : ${e.message}`);
          return { error:
              `✘ ${e.message}\n\n`
            + `ETIMEDOUT / ESOCKET → port sortant bloqué par l'hébergeur. `
            + `Aucun réglage Saltcorn n'y changera rien.\n`
            + `EAUTH → identifiants, ou identifiant qui n'est pas l'adresse complète.\n`
            + `wrong version number → 465 sans TLS, ou 587 avec.` };
        }
      },
    },
  }),
};
