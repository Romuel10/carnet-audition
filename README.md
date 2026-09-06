# Carnet d’audition — v3.2.2 beta.1 gratuite intelligente

Cette version reste sans abonnement, sans clé API et sans serveur obligatoire.

## Principe

Le mode recommandé combine trois niveaux :

1. **Dictée Android en direct** : le texte apparaît pendant la parole. Le moteur vocal du téléphone peut utiliser le réseau s’il le juge utile.
2. **Dictionnaire adaptatif** : noms, lieux, fokontany, grades et corrections déjà faites sont renvoyés comme vocabulaire prioritaire aux moteurs compatibles.
3. **Contrôle local Whisper après l’arrêt** : si un modèle local est installé, l’audio est relu en arrière-plan. L’application compare la proposition Whisper au texte direct au lieu de remplacer aveuglément un texte qui semble meilleur.

L’audio original reste toujours conservé pour la vérification humaine.

## Nouveautés v3.2.2

- correction locale automatique activée par défaut ;
- la révision Whisper se fait en arrière-plan, donc elle ne bloque plus le passage à la question suivante ;
- si le texte a été corrigé manuellement pendant la révision, il n’est pas écrasé ;
- comparaison automatique entre la dictée directe et la proposition locale ;
- proposition alternative visible avec **Utiliser** ou **Garder le texte direct** ;
- bouton **Vérifier le texte** pour relancer manuellement le contrôle d’un audio ;
- mémoire locale de corrections : l’application apprend certaines corrections de noms et lieux et les applique lors des auditions suivantes ;
- les mots appris sont aussi ajoutés au contexte prioritaire transmis à la dictée Android et à Whisper ;
- aucune donnée de cette mémoire n’est envoyée à un serveur par l’application ;
- export `.pvaud` inchangé : texte, audio, profil enquêteur et métadonnées de transcription restent importables sur le logiciel PC.

## Modèle local

Dans **Paramètres avancés → Correction locale intelligente** :

- **Base Q5** : recommandé sur un téléphone modeste, téléchargement d’environ 57 MiB ;
- **Small Q5** : plus lourd et plus lent, mais peut être plus précis, environ 181 MiB.

Le modèle est téléchargé une fois. Une fois installé, la correction Whisper fonctionne localement.

## Réglage recommandé

- Mode : **Intelligent gratuit — direct + contrôle local**
- Langue : **Malagasy**
- Qualité du micro : **Téléphone à proximité**
- Dictée provisoire : activée
- Forcer hors ligne : désactivé
- Vérification locale automatique : activée
- Apprentissage des corrections : activé
- Modèle : **Base Q5** pour commencer

## Mise à jour du dépôt GitHub

Après avoir décompressé ce dossier dans `Download` :

```bash
cd ~/carnet-audition
cp -r /sdcard/Download/carnet-audition-mobile-v3.2.2-beta1-gratuite-intelligente/. .
npm install
git add -A
git commit -m "Carnet v3.2.2 correction locale intelligente"
git push origin main
```

GitHub Actions produit l’artifact :

`Carnet-audition-v3.2.2-gratuite-intelligente-beta1-debug-apk`

## Test conseillé

1. Installer l’APK.
2. Ouvrir **Paramètres avancés**.
3. Installer **Base Q5**.
4. Enregistrer une Question de 10 à 20 secondes en Malagasy.
5. Appuyer sur Arrêter : le texte direct reste immédiatement disponible.
6. Continuer l’audition si nécessaire pendant que le contrôle local travaille en arrière-plan.
7. Vérifier si une proposition locale apparaît et choisir de l’utiliser ou non.
8. Corriger manuellement un nom de lieu mal reconnu, quitter le champ, puis refaire une phrase avec ce nom : la mémoire locale doit progressivement l’aider.

## Limite importante

Une transcription automatique ne doit pas être considérée comme la version juridique définitive d’une audition. Le texte doit être relu et les passages douteux vérifiés avec l’audio original avant intégration au procès-verbal.
