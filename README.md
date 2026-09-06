# Carnet d’audition Assistant PV — v3.3.0-beta.1

Version gratuite orientée terrain. Elle conserve le fonctionnement audio + texte validé sur Android et ajoute une interface plus professionnelle ainsi qu’une liaison directe avec le logiciel Windows.

## Nouveautés v3.3

- interface modernisée, sans emojis, avec navigation basse et résumé de session ;
- profil enquêteur mémorisé et modifiable ;
- dictée Android en direct + audio original ;
- correction locale Whisper facultative ;
- export `.pvaud` conservé ;
- nouvelle section **Connexion au logiciel** ;
- chiffrement AES-256-GCM du contenu avant transfert ;
- transfert direct de l’audition vers Assistant PV sur le même Wi-Fi ou point d’accès ;
- adresse PC + code de jumelage temporaire à 8 caractères ;
- aucun cloud, aucune API payante et aucun abonnement ;
- repli possible sur le fichier `.pvaud` et le câble USB.

## Connexion directe au PC

1. Sur Assistant PV Windows, ouvrir **Carnet d’audition**.
2. Ouvrir ou créer le PV qui doit recevoir l’audition.
3. Cliquer sur **Démarrer la liaison locale**.
4. Le PC affiche une adresse du type `http://192.168.1.20:17873` et un code à 8 caractères.
5. Sur le téléphone, ouvrir **Connexion au logiciel** et recopier l’adresse et le code.
6. Appuyer sur **Tester la connexion** puis **Envoyer l’audition au PC**.
7. Le texte et les audios sont ajoutés automatiquement au PV en cours.

Le PC et le téléphone doivent être sur le même réseau local. Sous Windows, autoriser Assistant PV sur les **réseaux privés** si le pare-feu le demande.

## Construction APK

```bash
npm install
npm run android:add
cd android
./gradlew assembleDebug
```

Le workflow GitHub Actions inclus produit automatiquement l’artifact `Carnet-audition-v3.3-beta1-connecte-debug-apk`.

## Confidentialité

La liaison directe utilise HTTP uniquement comme transport sur le réseau local. Le contenu de l’audition est chiffré sur le téléphone en AES-256-GCM avant l’envoi, avec une clé dérivée du code temporaire et ne doit être utilisée que sur un réseau de confiance. Arrêter la liaison après le transfert. L’audio original reste la référence en cas de doute sur la transcription.
