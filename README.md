# Carnet d’audition mobile — Assistant PV v3 beta

Cette application enregistre les questions et réponses, conserve les fichiers audio sur le téléphone et exporte un fichier `.pvaud` importable dans **Assistant PV Gendarmerie v3**.

## Utilisation

1. Renseigner l’enquêteur et la personne entendue.
2. Appuyer sur **Question**, parler, puis appuyer sur **Arrêter**.
3. Faire la même chose avec **Réponse**.
4. Vérifier/corriger la transcription affichée.
5. Appuyer sur **Exporter l’audition**.
6. Transférer le fichier `.pvaud` vers le PC, de préférence par câble USB ou moyen local autorisé.
7. Dans Assistant PV : **Carnet d’audition > Importer une audition**.

## Transcription

Le carnet tente d’utiliser le moteur de reconnaissance vocale fourni par le navigateur/téléphone avec `mg-MG` ou `fr-FR`. Selon Android, le navigateur et les langues installées, ce moteur peut être indisponible ou nécessiter les services vocaux du téléphone. L’audio original est donc toujours conservé et le texte est toujours modifiable.

## Construire une application Android avec Capacitor

Prérequis : Node.js 22 ou plus récent, Android Studio 2025.2.1 ou plus récent et le SDK Android (Capacitor 8).

```bash
npm install
npm run android:add
npm run android:open
```

Pour les mises à jour suivantes :

```bash
npm run android:sync
npm run android:open
```

Le script vérifie automatiquement la permission `RECORD_AUDIO` dans `AndroidManifest.xml`.

## Générer un APK avec GitHub Actions

Le dossier `.github/workflows/build-android.yml` est inclus. Si `carnet-mobile` est utilisé comme dépôt GitHub, le workflow construit automatiquement un APK de test (`app-debug.apk`) à chaque push sur `main`/`master`, ou manuellement via **Actions > Build Carnet Android APK > Run workflow**.

## Confidentialité

Le carnet n’envoie pas volontairement les auditions vers un serveur. Un export `.pvaud` contient toutefois des données sensibles et les audios encodés : il doit être stocké et transféré uniquement sur des supports autorisés.
