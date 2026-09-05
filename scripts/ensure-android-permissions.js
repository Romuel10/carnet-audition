const fs = require('fs');
const path = require('path');
const manifest = path.join(__dirname, '..', 'android', 'app', 'src', 'main', 'AndroidManifest.xml');
if (!fs.existsSync(manifest)) { console.error('AndroidManifest.xml introuvable. Lancez d’abord npm run android:add.'); process.exit(1); }
let text = fs.readFileSync(manifest, 'utf8');
const permissions = [
  '<uses-permission android:name="android.permission.RECORD_AUDIO" />',
  '<uses-permission android:name="android.permission.MODIFY_AUDIO_SETTINGS" />'
];
for (const permission of permissions) {
  const name = permission.match(/android:name="([^"]+)"/)[1];
  if (!text.includes(name)) text = text.replace(/<manifest([^>]*)>/, `<manifest$1>\n    ${permission}`);
}
fs.writeFileSync(manifest, text);
console.log('Permissions microphone Android vérifiées.');
