const fs = require('fs');
const path = require('path');
const manifest = path.join(__dirname, '..', 'android', 'app', 'src', 'main', 'AndroidManifest.xml');
if (!fs.existsSync(manifest)) { console.error('AndroidManifest.xml introuvable. Lancez d’abord npm run android:add.'); process.exit(1); }
let text = fs.readFileSync(manifest, 'utf8');
const permission = '<uses-permission android:name="android.permission.RECORD_AUDIO" />';
if (!text.includes('android.permission.RECORD_AUDIO')) text = text.replace(/<manifest([^>]*)>/, `<manifest$1>\n    ${permission}`);
fs.writeFileSync(manifest, text);
console.log('Permission microphone vérifiée.');
