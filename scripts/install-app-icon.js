const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const androidRoot = path.join(root, 'android');
const resRoot = path.join(androidRoot, 'app', 'src', 'main', 'res');
const manifest = path.join(androidRoot, 'app', 'src', 'main', 'AndroidManifest.xml');
const sourceIcon = path.join(root, 'www', 'icon.png');

if (!fs.existsSync(manifest)) {
  console.error('AndroidManifest.xml introuvable. Lancez d’abord npx cap add android.');
  process.exit(1);
}
if (!fs.existsSync(sourceIcon)) {
  console.error('www/icon.png introuvable.');
  process.exit(1);
}

const mipmapNoDpi = path.join(resRoot, 'mipmap-nodpi');
const drawableNoDpi = path.join(resRoot, 'drawable-nodpi');
const mipmapV26 = path.join(resRoot, 'mipmap-anydpi-v26');
const valuesDir = path.join(resRoot, 'values');
for (const dir of [mipmapNoDpi, drawableNoDpi, mipmapV26, valuesDir]) fs.mkdirSync(dir, {recursive:true});

fs.copyFileSync(sourceIcon, path.join(mipmapNoDpi, 'assistant_pv_icon.png'));
fs.copyFileSync(sourceIcon, path.join(drawableNoDpi, 'assistant_pv_icon_foreground.png'));

fs.writeFileSync(path.join(valuesDir, 'assistant_pv_icon_colors.xml'), `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="assistant_pv_icon_background">#0D2032</color>\n</resources>\n`);

const adaptive = `<?xml version="1.0" encoding="utf-8"?>\n<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n    <background android:drawable="@color/assistant_pv_icon_background" />\n    <foreground android:drawable="@drawable/assistant_pv_icon_foreground" />\n</adaptive-icon>\n`;
fs.writeFileSync(path.join(mipmapV26, 'assistant_pv_icon.xml'), adaptive);

let text = fs.readFileSync(manifest, 'utf8');
text = text.replace(/android:icon="[^"]+"/g, 'android:icon="@mipmap/assistant_pv_icon"');
if (/android:roundIcon="[^"]+"/.test(text)) text = text.replace(/android:roundIcon="[^"]+"/g, 'android:roundIcon="@mipmap/assistant_pv_icon"');
else text = text.replace(/<application\b/, '<application android:roundIcon="@mipmap/assistant_pv_icon"');
text = text.replace(/android:label="[^"]+"/g, 'android:label="Carnet d’audition"');
fs.writeFileSync(manifest, text);
console.log('Icône adaptative Assistant PV appliquée à l’installation et au lanceur Android.');
