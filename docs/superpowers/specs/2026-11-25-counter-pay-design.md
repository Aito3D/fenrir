# Payer au comptoir : design

Date : 2026-11-25. Mock-up : `2026-11-25-counter-pay-demo/index.html` (affichage A, remise confirmée).

## Pourquoi

Un client sur place : aujourd'hui, après « Créer la commande », l'opérateur clique encore facturer, encaisser,
préparer, colis, remettre. Tout cela pour quelqu'un qui est devant le comptoir. Un bouton « Payer » dans le modal
Nouvelle commande enchaîne tout, en guidant l'opérateur.

## Buts

- Un seul gros bouton « Payer {total} » dans le modal Nouvelle commande, avec une flèche à gauche. La flèche ou un
  appui long ouvre un menu : « Créer la commande » (le comportement actuel).
- Après « Payer », la colonne de droite devient un parcours avec barre de progression ; le panier reste visible :
  Commande → Paiement → Facture → Colis → Remise → Terminé.
- Dès le clic sur « Payer », le total, le bouton reset et le bouton Payer disparaissent : le parcours les remplace.
- Les étapes automatiques défilent seules. L'opérateur n'agit que pour : choisir le paiement (TPE ou manuel),
  répondre sur un article à stock 0, cliquer « Remis au client ».
- La facture n'est imprimable ou envoyable qu'une fois le paiement attribué : l'étape Facture relit la facture et ne
  se termine que si son solde est à 0 (facture acquittée). Sinon l'étape est en échec (« paiement non attribué »,
  Réessayer) et les boutons de facture restent absents.
- À l'étape Paiement, troisième choix « Paiement plus tard » (ex. une société dont un ouvrier vient chercher la
  commande) : rien n'est encaissé, la facture sort avec le montant dû, puis colis et remise comme d'habitude.
- Écran final : « Nouvelle vente », « Ouvrir la commande », et un bouton « Imprimer la facture » avec flèche à gauche
  dont le menu propose « Envoyer par mail ». Sans adresse mail, l'entrée est grisée et un clic dessus dit
  « Pas d'adresse mail pour ce client ».

## Hors périmètre

- Reprise d'une vente interrompue depuis la fiche commande (elle se termine avec les boutons existants).
- Lien de paiement dans le menu (idée de Claude, non demandée).
- Mode devis du modal : inchangé, pas de bouton Payer.

## À éviter

- Marquer « livré » dans Zoho avant que l'article ait changé de main.
- Perdre un paiement encaissé parce qu'une étape suivante échoue.

## Approches

1. **Le navigateur enchaîne les routes existantes (choisie).** Presque rien de nouveau côté serveur ; chaque étape
   est celle des boutons actuels ; onglet fermé = commande à son étape.
2. Une route serveur pour toute la chaîne : survit à l'onglet fermé, mais état stocké, progression poussée, reprise.
   Trop pour un cas rare.
3. Approche 1 + bouton « Reprendre la vente » : plus tard si besoin.

## Décisions

Du client :
- Bouton unique Payer + flèche/appui long, parcours guidé avec barre de progression.
- Affichage A (panier visible), remise confirmée par l'opérateur.
- Article réellement absent : tout encaisser, tout facturer, remettre ce qui est là ; le reste reste « À préparer ».
- Stock Zoho à 0 mais article présent : l'opérateur peut dire « Oui, il repart avec ».
- Encaisser d'abord, facturer ensuite (« pour le moment »).
- Bouton facture en split : Imprimer + menu « Envoyer par mail », grisé sans mail.

De Claude :
- « Paiement plus tard » est grisé pour le client de passage (une facture due sans nom ne se recouvre pas) ; un clic
  dit de choisir un client.
- La facture n'applique que le montant encaissé dans cette vente, pas tout l'acompte du client (le client de passage
  partage son acompte entre toutes les ventes comptoir).
- Paiement annulé : la commande existe, impayée ; le parcours s'arrête, le modal propose d'ouvrir la commande.
- Étape en échec : barre rouge, message disant ce qui est déjà fait, « Réessayer » et « Ouvrir la commande ».
- La question « stock 0 » n'apparaît que pour les lignes que le stock ne couvre pas, une question par ligne.
- « Oui, il repart avec » : l'écran final rappelle de corriger le stock Zoho. Aucune correction automatique.
- Envoi par mail = la fenêtre d'envoi de facture existante (`OrderInvoiceEmailModal`) ; impression = `usePrintBlob`.
- Services et articles non suivis : facturés, jamais dans un colis (règle actuelle). Une vente sans aucun article
  à emballer saute Colis et Remise.

## Construction

Frontend :
- `NewOrderDraftRow` : le bouton devient un split (Payer / menu). Nouveau composant du parcours dans la colonne.
- Un hook qui enchaîne : `createCounterOrder` → dialogue de paiement existant (TPE / manuel) → `POST …/invoice`
  scope `whole` → `POST …/picklists` → `POST …/packages` → attente du clic → `POST …/handover` (pick-up).
- Clés i18n dans toutes les langues gatées.

Backend (deux petits ajouts) :
- Facture : un plafond de crédit appliqué (montant encaissé dans la vente).
- Prélèvement : une dérogation par ligne qui laisse passer des unités que le stock ne couvre pas.

## Non vérifié

- Zoho accepte-t-il un prélèvement / colis sur un article à stock 0 ? Jamais essayé. S'il refuse, « Oui » devra
  d'abord ajuster le stock dans Zoho (une écriture nouvelle) : à trancher après un essai réel surveillé.
- Zoho accepte-t-il d'appliquer une partie seulement d'un acompte à une facture ? À lire dans le code de
  `invoice_shipped` au moment du plan, puis à confirmer au premier essai réel.

## Laissé au constructeur

Découpage des composants, noms, animation de la barre, textes exacts des erreurs.
