# carte web tMapOnline

Ce document décrit le fonctionnement de la carte web. Le navigateur reçoit la carte et les données du service Python, sans se connecter directement à Terraria. Le mod tModLoader transmet les informations du jeu au service, qui prépare les réponses API, les images et l’historique.

Une tuile est un carré du monde Terraria ; un chunk est une portion rectangulaire de l’image finale que le navigateur charge séparément.

## de l’API au pixel

1. `web/src/map/world-map.ts` crée la carte, charge les modules de `/api/site-config`, demande les métadonnées du monde et relie les renderers aux contrôleurs.
2. Le serveur envoie des fragments PNG déjà rasterisés avec `GET /api/world-map/tile?world=…&level=…&x=…&y=…`. Le navigateur ne transfère pas de tableaux RGB et ne recolore pas la carte entière à chaque ouverture.
3. `MapSnapshotCache` conserve snapshot et chunks dans IndexedDB. `MapPyramidLayerRenderer` maintient une vue grossière et choisit le niveau de détail du zoom. Les chunks visibles sont prioritaires ; les requêtes périmées sont annulées.
4. `MapViewportController` convertit molette, pinch et glissement en coordonnées viewport. La coordonnée du monde sous le point de zoom influe sur la priorité des requêtes réseau.
5. Une requête live légère met à jour joueurs et entités. Les marqueurs de PNJ, pylônes et autres objets forment une couche DOM distincte au-dessus de l’image.
6. Les changements de tuiles arrivent comme deltas de télémétrie, mettent à jour le stockage backend et invalident les chunks PNG concernés.

Un renderer dessine les données. Un contrôleur gère les actions de l’utilisateur et coordonne les requêtes. Un delta ne contient que les changements, pas la carte entière.

Les couches se mettent à jour séparément. La couche de base est l’image du monde ; l’exploration montre les zones révélées. Un masque en noir et blanc détermine où la couche est visible. Les autres couches affichent positions, itinéraires, Map Ping, arrière-plan et commandes. Une nouvelle couche doit obtenir ses données depuis l’API et les passer à son composant de rendu ; modifier une couche ne doit pas recharger les autres.

## propriété de l’état

| État                                                                | Source de vérité                             | Conservé après rechargement ?                           |
| ------------------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------- |
| Fonctions serveur, intervalles de collecte et durée d’historique    | `config.yaml` et `/api/site-config`          | Oui                                                     |
| Couches, fluidité et fréquence d’affichage                          | `localStorage` du navigateur                 | Oui, dans ce profil navigateur                          |
| Chunks et cache client                                              | IndexedDB du navigateur                      | Oui, jusqu’à la suppression des données du site         |
| Carte explorée, historique des joueurs/sessions, événements et boss | Fichiers du répertoire de données tMapOnline | Oui, indépendamment du navigateur                       |
| Positions live et PNJ actuels                                       | Snapshots récents du mod serveur             | Non, expirent si la source s’arrête ou devient ancienne |
| Textures/masques et pyramide PNG                                    | Stockage backend par monde et profil         | Oui                                                     |

`localStorage` conserve de petites préférences ; IndexedDB conserve des éléments plus volumineux comme les chunks. Ces données appartiennent au navigateur et à l’appareil, donc un autre téléphone ne les reçoit pas automatiquement. Le répertoire serveur contient les fichiers sur l’ordinateur où tourne tMapOnline.

Les réglages d’affichage web appartiennent à l’utilisateur du navigateur : ils ne sont ni globaux au serveur ni synchronisés entre appareils. Le serveur peut désactiver entièrement une couche ; le navigateur ne peut pas réactiver une fonction interdite côté serveur.

## composants principaux

- `app-shell.ts` et `core/modules.ts` : menu, actions/sections configurables et points d’extension communs.
- `components/map-display-settings.ts` : préférences locales et notifications de changement.
- `components/map-action-menu.ts`, `components/pixel-modal.ts`, `components/map-zoom-controls.ts` : comportements et apparence réutilisables du menu et des fenêtres.
- `map/world-map.ts` : racine de composition de la carte ; elle ne doit pas reprendre codecs, gestes, cache et toutes les couches DOM.
- `map/map-snapshot-cache.ts`, `map/map-tile-bitmap-cache.ts`, `map/map-tile-pyramid-renderer.ts` : chargement et cache d’images.
- `map/map-viewport-controller.ts` : coordonnées, gestes, zoom et requêtes de zones visibles.
- `map/map-entity-layer.ts` et `map/map-tooltip-controller.ts` : marqueurs live et infobulles du jeu.
- `map/map-player-path-service.ts`, `map/map-route-layer.ts`, `map/map-exploration-mask.ts` : sélection des itinéraires, masques d’exploration et tracés.

La racine de composition crée les composants et les relie ; un codec emballe et déballe les données. Recherchez les fichiers dans `web/src` : ils peuvent être déplacés, mais chaque composant doit garder une responsabilité limitée et compréhensible.

## performances et Safari/iOS

- Ne créez pas de canvas ou bitmap géant de la taille du monde lors du zoom. Travaillez par chunks visibles et gardez la couche grossière jusqu’à l’arrivée des détails.
- N’effacez pas une couche dessinée quand le niveau change : gardez l’ancien bitmap affiché jusqu’au nouveau pour éviter un flash de fond vide.
- Annulez les requêtes périmées et n’appliquez pas les réponses d’un ancien viewport à une nouvelle zone. Pendant un pinch, priorisez les chunks autour du centre du geste.
- Stabilisez taille et transform des couches/marqueurs pendant l’animation pinch. Ne recréez pas les sprites DOM des PNJ à chaque changement de zoom.
- Limitez raisonnablement les bitmaps et évitez les copies inutiles de grands tableaux de pixels : Safari iOS a des limites différentes d’un navigateur de bureau.
- Après ces changements, testez séparément zoom molette et pinch dans Safari iOS. Une compilation réussie ne suffit pas à prouver l’absence de scintillement sur téléphone.

## modifier la carte

1. Trouvez où la page charge les données et suivez-les jusqu’à l’API et au cache.
2. Chargez les grandes cartes à la demande : API par viewport, cache par monde/version/profil/niveau/coordonnées.
3. Demandez les gros jeux de données séparément des snapshots live compacts. N’ajoutez pas tout l’historique aux requêtes fréquentes.
4. Gardez les préférences utilisateur dans le navigateur et les intervalles, fonctions disponibles et périodes d’historique dans la configuration serveur.
5. Utilisez des composants réutilisables et les tokens pixel existants, avec comportement clavier et mobile.
6. Lors d’un changement de protocole, mettez à jour ensemble le consommateur TypeScript, le handler/store backend et le producteur du mod.
7. Après des changements TypeScript/SCSS, reconstruisez les assets avec `npm run build`.

## limites actuelles

La carte est transmise en chunks PNG. Les tableaux de tuiles restent la source côté serveur pour régénérer les images et les infobulles. Les zones inexplorées ne révèlent pas le monde réel au client : le serveur les masque. Les entités live dépendent de snapshots récents du mod ; un snapshot périmé n’est pas utilisé pour afficher des coordonnées.
