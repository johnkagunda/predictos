const axios = require('axios');

const headers = {
	'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
	Accept: 'application/json',
	Referer: 'https://www.betika.com/en-ke/live/soccer',
	Origin: 'https://www.betika.com',
};

async function probe() {
	// The live soccer page likely uses different params — try various combos
	const attempts = [
		// Different live endpoints
		'https://api.betika.com/v1/uo/matches?live=true&sport_id=14&limit=100',
		'https://api.betika.com/v1/uo/matches?live=1&sport_id=14&limit=100',
		'https://api.betika.com/v1/uo/matches?inplay=true&sport_id=14',
		'https://api.betika.com/v1/uo/prematch?live=true&sport_id=14',
		// Maybe the live page hits a totally different base
		'https://api.betika.com/v1/uo/live?sport_id=14',
		'https://api.betika.com/v1/ke/live?sport_id=14',
		'https://api.betika.com/v1/ke/matches?live=true&sport_id=14',
		// Livescore style
		'https://api.betika.com/v1/uo/livescores?sport_id=14',
		'https://api.betika.com/v1/uo/matches/live?sport_id=14',
		// Country-specific
		'https://api.betika.com/v1/ke/live',
		'https://api.betika.com/v1/ke/soccer/live',
	];

	for (const url of attempts) {
		try {
			const r = await axios.get(url, { headers, timeout: 6000 });
			const total = r.data?.meta?.total ?? r.data?.data?.length ?? '?';
			console.log(`OK ${r.status} [${total}]: ${url}`);
			if (r.data?.data?.[0]) {
				const k = Object.keys(r.data.data[0]).join(', ');
				console.log(`  keys: ${k}`);
			}
		} catch (e) {
			console.log(`${e.response?.status ?? 'NET'}: ${url}`);
		}
	}
}

probe();
