# WordWise

<!-- wordwise-readme-language:begin -->
<p align="right">
  <a href="README.zh-CN.md">中文</a> | <a href="README.fr.md"><strong>Français</strong></a> | <a href="README.md">English</a>
</p>
<!-- wordwise-readme-language:end -->

WordWise est une application de bureau pour apprendre le vocabulaire anglais,
avec des séances ciblées et une mémorisation durable. Elle vous permet de créer
votre liste personnelle, de vous entraîner à votre rythme, de revoir vos erreurs
et de repérer les mots que vous confondez le plus souvent.

**Nous publions désormais une partie des algorithmes de l’application.**

L’application de bureau est conçue pour fonctionner localement. Les résultats
d’apprentissage restent sur votre appareil. Un modèle de langage local peut,
en option, fournir un retour sémantique sur vos réponses écrites.

<!-- wordwise-web-v2:begin -->
## WordWise Web v2.0 — Bêta publique

**[Ouvrir WordWise Web](https://wordwise.dpdns.org/)** pour créer un compte ou
vous connecter avec votre compte existant. Le portail en ligne est désormais
en version v2.0 ; les téléchargements de l’application de bureau ci-dessous
restent en version v1.0. Ce dépôt publie une sélection du code de l’application
de bureau et de ses algorithmes, sans inclure le code complet du service hébergé.

- Révisez le vocabulaire anglais en répondant en chinois ou en français.
- Choisissez une interface en français, en chinois ou en anglais. À la première
  visite, la langue du navigateur détermine l’interface : français → français,
  chinois → chinois, sinon anglais. Votre choix enregistré est prioritaire
  lors des visites suivantes.
- Changez la langue de l’interface dans **Paramètres et vocabulaire → Langue**.
  Un sélecteur compact est également disponible avant la connexion. La langue
  choisie définit le mode d’étude par défaut ; vous pouvez sélectionner le mode
  d’étude séparément dans la barre latérale.
- Le mode français propose **TOEFL, IELTS, Tous les mots** et votre liste
  personnelle **Mes mots**, avec des séances adaptatives, la révision des erreurs,
  une carte des confusions, des indices et l’import/export du vocabulaire.

<!-- wordwise-web-v2:end -->

## Fonctionnalités

- Modes de pratique aléatoire, dans l’ordre et adaptatif
- Répétition espacée et séances centrées sur les erreurs
- Carte personnelle des confusions récurrentes
- Import et export de vos listes de vocabulaire
- Prise en charge de la création de versions de bureau pour macOS et Windows

## Démarrage rapide

```bash
npm install
npm test
npm start
```

Le moteur natif de vocabulaire peut être reconstruit localement avec Rust
si aucun module précompilé compatible n’est disponible :

```bash
npm run build --prefix vocab-core
```

Le code source public n’inclut pas les poids des modèles locaux, les listes
de mots intégrées, les archives audio, les ressources de distribution payante,
les travaux de recherche privés, les outils de licence réservés à l’opérateur
ni les installateurs. Si vous ajoutez du vocabulaire ou des modèles, utilisez
des sources que vous êtes autorisé à redistribuer.

<!-- wordwise-public-tools:begin -->
## Outils de développement publics

Le code source comprend des outils pour regrouper les fichiers audio, préparer
les bases de vocabulaire et créer les versions de bureau. Deux vérifications
en lecture seule contrôlent la **liste des fichiers publics dans l’index Git**
et la **sélection des fichiers des paquets macOS/Windows** :

```bash
npm run check:public-files
npm run check:package-files
```

<!-- wordwise-public-tools:end -->

## Téléchargements

### La version d’essai en ligne est disponible sur [WordWise-Web](https://wordwise.dpdns.org)

- Baidu Netdisk : [WordWise-v1.0.0](https://pan.baidu.com/s/1LD4QVatnQr7FSxPloC1c5A), code d’accès : vjra
- Google Drive : [WordWise-v1.0.0](https://drive.google.com/drive/folders/1jb0jFgo42EUx7rVZQSWyhnYVrrr3LOGF?usp=sharing)

**Pour toute question ou pour demander un essai gratuit d’un an, contactez le développeur à feedback@wordwise.dpdns.org.**

## Licence

WordWise est publié sous licence MIT. Consultez [`LICENSE`](LICENSE).
