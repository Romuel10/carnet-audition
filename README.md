# Carnet d’audition — Assistant PV Gendarmerie v3.2.0-beta.1

Cette version part de la v3.1 beta.3 validée sur Android et ajoute une refonte de l’interface, une vraie icône d’installation et un mode de transcription en ligne haute précision avec secours automatique. Le relais ne reçoit jamais la clé du fournisseur depuis l’APK ; seuls l’audio nécessaire à la transcription et, si vous le renseignez, le vocabulaire métier du champ Dictionnaire sont envoyés au service en ligne.

## Nouveautés principales

- Interface entièrement revue : style sobre, professionnel, sans emojis, animations discrètes, meilleure hiérarchie visuelle et boutons d’enregistrement plus clairs.
- Icône Assistant PV appliquée à l’APK Android et à l’écran d’installation.
- Mode **En ligne haute précision** : la dictée Android continue d’afficher un texte provisoire immédiatement, pendant que l’audio PCM est envoyé vers un relais sécurisé. Le texte cloud corrige progressivement le texte provisoire.
- Secours automatique : si le réseau ou le relais tombe, l’enregistrement audio continue et la dictée Android reste active.
- Mode **Dictée Android** conservé.
- Mode **Local privé** conservé avec le moteur local existant.
- Le profil enquêteur reste enregistré et modifiable.
- L’export `.pvaud` conserve désormais la transcription provisoire et la transcription en ligne, en plus des audios.

## Pourquoi un relais sécurisé ?

La clé du fournisseur de transcription ne doit jamais être incluse dans l’APK. Le dossier `relay/` contient un petit serveur Node.js qui garde la clé côté serveur et reçoit uniquement le flux audio de la Question/Réponse.

Le relais utilise par défaut :

- `gpt-4o-mini-transcribe` pour les corrections rapides pendant la parole ;
- `gpt-transcribe` pour la transcription finale après l’arrêt.

La langue envoyée est `mg` pour le malagasy. Le dictionnaire prioritaire, s’il est renseigné, est transmis comme contexte de transcription. Le profil enquêteur et l’identité de la personne ne sont pas ajoutés automatiquement au contexte en ligne.

## Mise à jour du dépôt Android

Après décompression du ZIP :

```bash
cd ~/carnet-audition
cp -r /sdcard/Download/carnet-audition-mobile-v3.2.0-beta1/. .
npm install
git add -A
git commit -m "Modern UI and online Malagasy transcription v3.2"
git push origin main
```

GitHub Actions construit l’artifact :

`Carnet-audition-v3.2-beta1-debug-apk`

## Configuration du mode en ligne

1. Déployer le dossier `relay/` sur un serveur Node.js exposé en HTTPS/WSS.
2. Définir sur ce serveur `OPENAI_API_KEY` et `APP_SHARED_SECRET`.
3. Dans l’application, choisir **En ligne haute précision**.
4. Renseigner l’URL `wss://...` du relais et le jeton `APP_SHARED_SECRET`.
5. Appuyer sur **Tester la connexion**.
6. Quand le statut indique **Connexion sécurisée**, faire un essai fictif avant une audition réelle.

Ne placez jamais `OPENAI_API_KEY` dans GitHub, dans Termux en clair dans le projet, ni dans l’application mobile.

## Confidentialité

En mode en ligne, le flux audio de la Question/Réponse est transmis au service configuré pour transcription. L’identité complète de la personne, le profil de l’enquêteur et le fichier `.pvaud` ne sont pas envoyés par le relais fourni. Utiliser ce mode pour des données réelles uniquement si le cadre de travail de l’unité autorise le service distant choisi.
