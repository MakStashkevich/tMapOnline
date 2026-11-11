# mise à jour de tMapOnline

Ce document explique comment mettre à jour la carte web, le service Python (backend) et le mod serveur `tMapOnline`. Une mise à jour remplace les programmes, mais ne doit pas effacer le monde sauvegardé, l’historique des joueurs ni la progression des boss.

## composants du projet

- Le paquet Python et sa commande s’appellent `tmaponline`.
- Sur macOS, un LaunchAgent est un service système qui peut lancer `tmaponline` depuis l’environnement virtuel du projet à la connexion.
- Le code source du mod serveur et son ID s’appellent `tMapOnline`.
- L’artefact compilé s’appelle `tMapOnline.tmod`.

Après une modification du code, compilez le paquet et installez-le dans le profil tModLoader. Un profil est une installation distincte avec ses propres mods et mondes. Avant de remplacer le mod, vérifiez que les joueurs sont déconnectés et sauvegardez le monde ainsi que la liste des mods activés.

## données utilisateur

Par défaut, les données du mod et de la carte sont dans `~/Library/Application Support/tMapOnline`. `~` désigne le dossier personnel de l’utilisateur actuel. Ce répertoire contient les données des mondes, l’historique des joueurs, le cache d’images et `boss-victories.json`, qui conserve la progression des boss. Ne supprimez pas ce répertoire lors d’une mise à jour. Si vous changez `storage.data_dir`, déplacez d’abord les fichiers puis vérifiez que le programme les trouve.

## installer et lancer la version mise à jour

Exécutez les commandes depuis la racine du projet. L’environnement Python est un dossier séparé pour les bibliothèques tMapOnline, afin de ne pas les mélanger aux autres programmes.

1. Créez ou activez l’environnement et installez le paquet depuis le dossier courant : `python3 -m pip install -e .`. L’option `-e` indique à Python d’utiliser directement le code source ; il n’est donc pas nécessaire de reconstruire le paquet après chaque modification.
2. Lancez la carte avec `tmaponline --config config.local.yaml serve` ou `tmaponline --config config.local.yaml run`. `--config` choisit le fichier de paramètres. `serve` lance uniquement le service web ; `run` lance aussi le serveur du jeu si la configuration en indique un.
3. Compilez le mod pour la version tModLoader installée : `TML_ROOT="/path/to/tModLoader" python3 tools/build-mod.py`.
4. Vérifiez `dist/tMapOnline.tmod` dans un profil de test ou une copie du monde. La compilation crée ce fichier sans l’installer dans le profil serveur.
5. Avant de remplacer le mod, vérifiez que les joueurs sont partis. Sauvegardez le monde, l’ancien `.tmod` et la liste des mods activés.
6. Copiez `tMapOnline.tmod` dans le profil serveur, activez le mod et redémarrez à un moment où aucun joueur n’est connecté.
7. Ouvrez `/healthz` pour tester la réponse du service, `/api/site-config` pour voir les fonctions activées et `/api/status` pour l’état du serveur. Vérifiez ensuite la carte, les données récentes et Map Ping dans les deux sens.

## retour arrière

Si la nouvelle version ne démarre pas, arrêtez-la normalement et restaurez l’ancien `.tmod`, la liste des mods activés et la version précédente du service. Un retour arrière restaure une version fonctionnelle sauvegardée. Ne supprimez pas le répertoire de données tMapOnline.
