const fs = require('fs');

const file = 'android/app/src/main/AndroidManifest.xml';
let text = fs.readFileSync(file, 'utf8');

const permissions = [
  '<uses-permission android:name="android.permission.RECORD_AUDIO" />',
  '<uses-permission android:name="android.permission.MODIFY_AUDIO_SETTINGS" />'
];

for (const permission of permissions) {
  const name = permission.match(/android:name="([^"]+)"/)[1];

  if (!text.includes(name)) {
    text = text.replace(
      /<manifest([^>]*)>/,
      `<manifest$1>\n    ${permission}`
    );
  }
}

fs.writeFileSync(file, text);
console.log('Permissions microphone Android vérifiées.');
