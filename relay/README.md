# Relais sécurisé de transcription v1.1 — temps réel

Ce service garde la clé API hors de l’APK et transmet le flux audio du Carnet à une session de transcription temps réel. La dictée en ligne utilise `gpt-live-transcribe`; après l’arrêt, une révision optionnelle avec `gpt-transcribe` peut corriger le texte final.

Le téléphone envoie le flux audio de la Question/Réponse, le contexte de vocabulaire configuré par l’utilisateur et la langue principale. Le dossier complet, le profil enquêteur et les autres auditions ne sont pas envoyés par ce relais.

## Variables obligatoires

- `OPENAI_API_KEY` : clé API stockée uniquement sur le serveur.
- `APP_SHARED_SECRET` : jeton long et aléatoire à saisir dans le Carnet.
- `PORT` : optionnel, 8787 par défaut.

## Réglages conseillés

- `OPENAI_LIVE_MODEL=gpt-live-transcribe`
- `OPENAI_LIVE_DELAY=low` (`minimal`, `low`, `medium`, `high`, `xhigh`)
- `OPENAI_FINAL_MODEL=gpt-transcribe`
- `OPENAI_FINAL_REFINEMENT=true`

`low` donne un bon compromis terrain : le texte commence à apparaître rapidement, puis la révision finale peut corriger les mots difficiles après l’arrêt.

## Lancer localement

```bash
npm install
OPENAI_API_KEY="..." APP_SHARED_SECRET="..." npm start
```

Test : `GET /health`.

## Déploiement Render

1. Créez un dépôt GitHub contenant le contenu de ce dossier `relay` à la racine.
2. Dans Render, créez un **Blueprint** depuis ce dépôt (le fichier `render.yaml` est fourni).
3. Saisissez `OPENAI_API_KEY` et un `APP_SHARED_SECRET` long et aléatoire dans les variables secrètes.
4. Une fois le service déployé, copiez son URL HTTPS, par exemple `https://assistant-pv-transcription-relay.onrender.com`.
5. Dans le Carnet, collez cette URL dans **Adresse sécurisée du service**. L’application la convertit automatiquement en `wss://`.
6. Saisissez le même `APP_SHARED_SECRET`, puis appuyez sur **Tester la connexion**.

Pour une dictée réellement immédiate, évitez un hébergement qui s’endort entre les requêtes : un redémarrage à froid ajoute plusieurs secondes avant la première transcription.

Ne mettez jamais `OPENAI_API_KEY` dans le code de l’APK, le dépôt GitHub public ou les paramètres visibles de l’application.
