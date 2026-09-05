# Relais sécurisé de transcription en ligne

Ce petit service garde la clé du fournisseur hors de l’APK. Le téléphone envoie uniquement le flux audio de la Question/Réponse au relais pendant l’enregistrement. Le profil enquêteur, l’identité et le dossier complet ne sont pas envoyés par ce relais.

## Variables obligatoires

- `OPENAI_API_KEY` : clé API stockée uniquement sur le serveur.
- `APP_SHARED_SECRET` : jeton long et aléatoire à saisir ensuite dans l’application mobile.
- `PORT` : optionnel, 8787 par défaut.

## Lancer localement

```bash
cd relay
npm install
OPENAI_API_KEY="..." APP_SHARED_SECRET="..." npm start
```

Test HTTP : `GET /health`.

Pour le téléphone sur Internet, déployez ce dossier sur un hébergeur Node.js avec HTTPS/WSS (Render, Railway, Cloud Run, VPS, etc.) puis utilisez l’URL WebSocket publique dans l’application, par exemple `wss://mon-relais.example.com`.

Ne mettez jamais `OPENAI_API_KEY` dans `www/app.js`, dans GitHub ou dans l’APK.
