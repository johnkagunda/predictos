const fs = require('fs');

function svgIcon(size) {
	const r = Math.round(size * 0.2);
	const fs2 = Math.round(size * 0.5);
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
  <rect width="${size}" height="${size}" rx="${r}" fill="#f0883e"/>
  <text x="50%" y="54%" font-size="${fs2}" text-anchor="middle" dominant-baseline="middle" fill="#0d1117">🎯</text>
</svg>`;
}

fs.writeFileSync('public/icon-192.svg', svgIcon(192));
fs.writeFileSync('public/icon-512.svg', svgIcon(512));

// Also write the PNG references as SVG — browsers support SVG icons in manifests
// Update manifest to use .svg
const manifest = JSON.parse(fs.readFileSync('public/manifest.json', 'utf8'));
manifest.icons = [
	{ src: '/icon-192.svg', sizes: '192x192', type: 'image/svg+xml', purpose: 'any maskable' },
	{ src: '/icon-512.svg', sizes: '512x512', type: 'image/svg+xml', purpose: 'any maskable' },
];
fs.writeFileSync('public/manifest.json', JSON.stringify(manifest, null, 2));
console.log('Icons + manifest updated');
