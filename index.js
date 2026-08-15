/**
 * smtp-envoi V11 — plugin Saltcorn pour le pipeline Sélection Habitat.
 *
 * POINT IMPORTANT V11 : aucune dépendance SMTP externe n'est chargée ici.
 * Saltcorn peut donc toujours charger le plugin, afficher sa configuration
 * (engrenage) et enregistrer ses actions. Nodemailer n'est chargé qu'au
 * moment où une action d'envoi est réellement exécutée.
 */
const Workflow = require("@saltcorn/data/models/workflow");
const Form = require("@saltcorn/data/models/form");
const Table = require("@saltcorn/data/models/table");

const loadSend = () => {
  try {
    return require("./send");
  } catch (e) {
    throw new Error(
      "smtp-envoi est chargé, mais le moteur d'envoi est indisponible : " +
      (e && e.message ? e.message : String(e))
    );
  }
};

const configuration_workflow = () =>
  new Workflow({
    steps: [
      {
        name: "Serveur SMTP",
        form: () =>
          new Form({
            blurb:
              "Configurez ici le compte SMTP utilisé par tout le pipeline. " +
              "Port 465 = TLS direct ; port 587 = STARTTLS (TLS décoché ici).",
            fields: [
              { name: "host", label: "Serveur SMTP", type: "String", required: true,
                default: "ssl0.ovh.net",
                sublabel: "Nom du serveur seul, sans https:// ni port" },
              { name: "port", label: "Port", type: "Integer", default: 465 },
              { name: "tls", label: "TLS direct", type: "Bool", default: true,
                sublabel: "À cocher avec le port 465 ; décocher avec 587/STARTTLS" },
              { name: "username", label: "Identifiant", type: "String", required: true,
                sublabel: "Adresse e-mail complète du compte SMTP" },
              { name: "password", label: "Mot de passe", type: "String",
                input_type: "password", required: true },
              { name: "from_email", label: "Adresse expéditrice", type: "String",
                required: true,
                sublabel: "En pratique, utilisez la même adresse que l'identifiant SMTP" },
              { name: "from_nom", label: "Nom affiché (optionnel)", type: "String",
                default: "" },
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
                sublabel: "Attendue : notification" },
              { name: "redirection_test", label: "Adresses de redirection (mode test)",
                type: "String", default: "",
                sublabel: "Séparées par des virgules. Vide = simulation pure sans connexion SMTP." },
              { name: "mode_test", label: "MODE TEST — ne pas écrire aux vrais destinataires",
                type: "Bool", default: true,
                sublabel: "Interrupteur général du module SMTP." },
            ],
          });
        },
      },
    ],
  });

const leadFields = [
  { name: "cle_destinataires", label: "Variable — destinataires",
    type: "String", default: "destinataires_prevus",
    sublabel: "Tableau [{email, role, user_id}], ou liste d'adresses" },
  { name: "cle_sujet", label: "Variable — objet", type: "String", default: "sujet" },
  { name: "cle_corps", label: "Variable — corps HTML", type: "String", default: "corpsMail" },
  { name: "cle_lead", label: "Variable — id du lead", type: "String", default: "lead" },
  { name: "cle_mode_test", label: "Variable — mode test local", type: "String", default: "mode_test" },
  { name: "role_defaut", label: "Rôle par défaut", type: "String", default: "negociateur" },
];

module.exports = {
  sc_plugin_api_version: 1,
  plugin_name: "smtp-envoi",
  configuration_workflow,

  actions: (cfg) => ({
    smtp_envoi_lead: {
      configFields: leadFields,
      run: async (args) => {
        let log = () => {};
        try {
          const send = loadSend();
          log = send.log;
          const ctx = send.contexte(args);
          const c = (args && args.configuration) || {};
          return await send.runSend({
            cfg,
            cibles: send.normaliser(
              ctx[c.cle_destinataires || "destinataires_prevus"],
              c.role_defaut || "negociateur"
            ),
            sujet: ctx[c.cle_sujet || "sujet"] || "Nouveau lead",
            corps: ctx[c.cle_corps || "corpsMail"] || "",
            leadId: ctx[c.cle_lead || "lead"] || null,
            modeTestLocal: c.cle_mode_test ? ctx[c.cle_mode_test] === true : false,
          });
        } catch (e) {
          try { log(1, `exception dans smtp_envoi_lead : ${e.message}`); } catch (_) {}
          return {
            nb_envoyes: 0,
            nb_echecs: 1,
            erreur_envoi: `exception : ${e.message}`,
          };
        }
      },
    },

    // Action conservée pour compatibilité et usage manuel. Le workflow actuel
    // de quarantaine peut continuer à employer smtp_envoi_lead avec ses propres
    // variables sujetQ/corpsQ/destinataires_q.
    smtp_envoi_quarantaine: {
      configFields: [
        { name: "cle_motif", label: "Variable — motif", type: "String", default: "motif_quarantaine" },
        { name: "cle_email_id", label: "Variable — id e-mail source", type: "String", default: "email_brut" },
        { name: "cle_reference", label: "Variable — référence extraite", type: "String", default: "reference_bien" },
        { name: "cle_mode_test", label: "Variable — mode test local", type: "String", default: "mode_test" },
      ],
      run: async (args) => {
        let log = () => {};
        try {
          const send = loadSend();
          log = send.log;
          const ctx = send.contexte(args);
          const c = (args && args.configuration) || {};
          const motif = ctx[c.cle_motif || "motif_quarantaine"] || ctx.motif_bien || "non précisé";
          const emailId = ctx[c.cle_email_id || "email_brut"] || "?";
          const ref = ctx[c.cle_reference || "reference_bien"] || "";
          const tDest = Table.findOne({ name: "destinataire_custom" });
          const rows = tDest ? await tDest.getRows({ portee: "tous", actif: true }) : [];
          return await send.runSend({
            cfg,
            cibles: send.normaliser(rows.map((r) => ({ email: r.email, role: "quarantaine" })), "quarantaine"),
            sujet: `[QUARANTAINE] e-mail ${emailId} — ${motif}`,
            corps:
              `<p>Un e-mail n'a pas pu être traité automatiquement.</p>` +
              `<ul><li><b>Motif :</b> ${motif}</li>` +
              `<li><b>Référence extraite :</b> ${ref || "(aucune)"}</li>` +
              `<li><b>E-mail source :</b> ${emailId}</li></ul>`,
            leadId: ctx.lead_id || ctx.lead || null,
            modeTestLocal: c.cle_mode_test ? ctx[c.cle_mode_test] === true : false,
          });
        } catch (e) {
          try { log(1, `exception dans smtp_envoi_quarantaine : ${e.message}`); } catch (_) {}
          return { nb_envoyes: 0, nb_echecs: 1, erreur_envoi: `exception : ${e.message}` };
        }
      },
    },

    // Le test passe par EXACTEMENT la même file globale et le même transport
    // que les vrais envois. Il ne fait pas verify() avant l'envoi.
    smtp_tester: {
      configFields: [
        { name: "adresse_test", label: "Envoyer à", type: "String", required: true },
      ],
      run: async (args) => {
        try {
          const send = loadSend();
          const dest = String(((args && args.configuration) || {}).adresse_test || "").trim();
          await send.runTest(
            cfg,
            dest,
            "Test SMTP — pipeline Sélection Habitat",
            "<p>Si vous lisez ceci, le plugin SMTP Saltcorn fonctionne.</p>"
          );
          send.log(4, `test SMTP réussi vers ${dest}`);
          return { notify: `✔ Envoyé à ${dest}` };
        } catch (e) {
          try { loadSend().log(2, `test SMTP en échec : ${e.message}`); } catch (_) {}
          return { error: `✘ ${e.message}` };
        }
      },
    },
  }),
};
