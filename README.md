# smtp-envoi

Pendant de `imap-idle` : l'un relève la boîte, l'autre notifie les négociateurs.
Mêmes conventions, même mode d'installation.

## Pourquoi ce module

L'action native `send_email` perd son champ **body** à l'enregistrement du
formulaire de configuration. Et `run_js_code` n'expose pas `require`, donc
ni nodemailer ni SMTP.

Ici la configuration d'une action ne contient **que des noms de variables** —
des chaînes courtes. Le texte du message vient du contexte du workflow, produit
par le nœud `notifier`. Il n'y a rien à saisir qui puisse se vider.

## Installation

Comme `imap-idle` : par GitHub.

**1. Publier le dépôt**

```bash
cd saltcorn/plugin-smtp-envoi
git push -u origin main
```

Le dépôt `SidyLaye/saltcorn-smtp-envoi` doit exister au préalable sur GitHub,
en **public** — Saltcorn le clone sans authentification.

**2. Ajouter le module**

Réglages → Magasin de modules → Nouveau :

| Champ | Valeur |
|---|---|
| Nom | `smtp-envoi` |
| Source | **git** |
| Emplacement | `https://github.com/SidyLaye/saltcorn-smtp-envoi.git` |
| Version | *(laisser vide)* |

Saltcorn clone le dépôt et lance `npm install` lui-même : `nodemailer` est
installé automatiquement.

Puis **redémarrer le conteneur** — les actions d'un module ne sont chargées
qu'au démarrage.

> ⚠ Le nom du module doit correspondre à `plugin_name` dans `index.js`, soit
> `smtp-envoi`. Un écart empêche les actions d'apparaître dans la liste des
> déclencheurs, sans message d'erreur.

## Configuration

**Étape 1 — Serveur SMTP**

| Champ | OVH mutualisé |
|---|---|
| Serveur | `ssl0.ovh.net` — ou `ex.mail.ovh.net` si Exchange |
| Port | `465` |
| TLS | **coché** |
| Identifiant | l'adresse **complète** |
| Expéditeur | la même adresse que l'identifiant |

**Étape 2 — Journal et mode test**

Table de journalisation : `notification`.
**Mode test : coché** pour l'instant.

## Vérifier avant de brancher le workflow

Déclencheur `When = Never`, action **`smtp_tester`**, votre adresse.

Cette action ignore le mode test — c'est sa raison d'être. Elle appelle
`verify()` avant d'envoyer, ce qui distingue une panne de connexion d'un
refus d'authentification.

| Erreur | Cause |
|---|---|
| `ETIMEDOUT`, `ESOCKET` | port sortant bloqué par l'hébergeur — aucun réglage n'y changera rien |
| `EAUTH` | identifiants, ou identifiant qui n'est pas l'adresse complète |
| `wrong version number` | 465 sans TLS, ou 587 avec |

**Tant que ce test ne passe pas, ne touchez pas au workflow.**

## Brancher les deux étapes

| Étape | Action | Next step |
|---|---|---|
| `envoyer_emails` | `smtp_envoi_lead` | `maj_lead` |
| `envoyer_quarantaine` | `smtp_envoi_quarantaine` | *(fin)* |

Laissez **`Only if` vide**. Les actions gèrent elles-mêmes le mode test, et une
condition qui bloquerait l'étape empêcherait aussi la journalisation.

## Ce que `notifier` doit produire

```js
return {
  mode_test: MODE_TEST,
  destinataires_prevus: uniq,   // [{ email, role, user_id }]
  sujet,
  corpsMail,
  nb_destinataires: uniq.length,
};
```

Le tableau d'objets est important : une simple liste d'adresses perdrait `role`
et `user_id`, et `notification` ne pourrait plus répondre à « ce négociateur
a-t-il été prévenu », ce qu'attend le tableau de bord.

## Passage en production

Décochez **Mode test** dans la configuration du module. Un seul interrupteur,
sans toucher au workflow.

## Points de vigilance

**Le mot de passe** est stocké en base, comme celui d'`imap-idle`. Présent dans
tout `pg_dump`.

**SPF** : si les messages partent en spam, ajoutez l'enregistrement SPF d'OVH au
DNS de `ambs-agency`. Inutile pour les tests.

**Débit** : OVH limite les envois par heure sur les offres mutualisées. Un lead
génère 3 à 5 messages — à surveiller au premier lot réel.

**Après modification d'un fichier** : `git push`, puis dans le magasin de
modules, désinstaller et réinstaller `smtp-envoi`, puis redémarrer le
conteneur. Saltcorn ne va pas rechercher les commits tout seul.
