# Carnet d’audition — Assistant PV Gendarmerie v3.2.0-beta.2

Version terrain avec interface professionnelle, audio natif, profil enquêteur persistant, export `.pvaud`, dictée Android de secours et **transcription en ligne réellement temps réel** via un relais sécurisé.

## Nouveauté beta.2

Le mode **En ligne haute précision** n’envoie plus des fenêtres audio successives à une API de fichiers. Le relais ouvre désormais une session de transcription Realtime persistante : le texte peut arriver sous forme de deltas pendant que la personne parle. Après l’arrêt, le texte temps réel est immédiatement conservé, puis une révision finale haute précision peut le corriger en arrière-plan.

Architecture :

```text
Micro Android (audio original conservé)
        │
        ├─ Dictée Android de secours
        │
        └─ PCM 16 kHz → relais HTTPS/WSS
                         │
                         ├─ Realtime : gpt-live-transcribe
                         │     → texte en direct
                         │
                         └─ Final : gpt-transcribe
                               → correction après arrêt
```

La clé API reste uniquement sur le serveur `relay/`, jamais dans l’APK.

## Mise à jour du dépôt Android

Après décompression :

```bash
cd ~/carnet-audition
cp -r /sdcard/Download/carnet-audition-mobile-v3.2.0-beta2/. .
npm install
git add -A
git commit -m "Realtime online Malagasy transcription v3.2 beta2"
git push origin main
```

GitHub Actions produit l’artifact :

`Carnet-audition-v3.2-beta2-debug-apk`

## Relais en ligne

Le dossier `relay/` contient la version 1.1.0. Déployez **ce dossier seul** dans un dépôt séparé ou placez son contenu à la racine du dépôt du relais. Les étapes Render sont décrites dans `relay/README.md`.

Dans l’application :

1. choisissez **En ligne haute précision** ;
2. renseignez l’URL HTTPS/WSS du relais ;
3. renseignez le même `APP_SHARED_SECRET` ;
4. appuyez sur **Tester la connexion** ;
5. choisissez Malagasy ;
6. commencez une Question ou une Réponse.

Pour une vraie audition, le mode en ligne transmet le flux audio au service de transcription configuré. Utilisez-le uniquement si le cadre de confidentialité de votre unité l’autorise. L’audio original reste enregistré sur le téléphone même en cas de coupure réseau.
