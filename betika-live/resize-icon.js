/**
 * Run after placing icon.png in betika-live/public/
 * Requires: npm install sharp  (one-time)
 * Usage: node resize-icon.js
 */
const sharp = require('sharp');
const path  = require('path');

const src = path.join(__dirname, 'public', 'icon.png');

async function run() {
	await sharp(src).resize(192, 192).toFile(path.join(__dirname, 'public', 'icon-192.png'));
	await sharp(src).resize(512, 512).toFile(path.join(__dirname, 'public', 'icon-512.png'));
	await sharp(src).resize(180, 180).toFile(path.join(__dirname, 'public', 'apple-touch-icon.png'));
	console.log('Icons generated: icon-192.png, icon-512.png, apple-touch-icon.png');
}

run().catch(console.error);
