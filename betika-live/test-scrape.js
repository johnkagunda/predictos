const puppeteer = require('puppeteer-core');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

(async () => {
	const browser = await puppeteer.launch({
		executablePath: CHROME,
		headless: true,
		args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
	});
	const page = await browser.newPage();
	await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36');

	await page.setRequestInterception(true);
	page.on('request', r => {
		const t = r.resourceType();
		['image','font','stylesheet','media'].includes(t) ? r.abort() : r.continue();
	});

	await page.goto('https://www.betika.com/en-ke/live/soccer', { waitUntil: 'domcontentloaded', timeout: 45000 });
	await new Promise(r => setTimeout(r, 3000));

	// Use the page's own fetch (carries cookies/session) to get matches
	const result = await page.evaluate(async () => {
		const res = await fetch('https://live.betika.com/v1/uo/matches?sport_id=14&limit=100');
		return await res.json();
	});

	const matches = result.data || [];
	console.log('Total soccer matches:', matches.length);

	if (matches[0]) {
		console.log('\nAll keys on first match:');
		console.log(Object.keys(matches[0]).join('\n'));
		console.log('\nFull first match:');
		console.log(JSON.stringify(matches[0], null, 2));
	}

	await browser.close();
})().catch(e => console.error('FATAL:', e.message));
