const axios = require('axios');

const headers = {
	'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
	Accept: 'application/json',
	Referer: 'https://www.betika.com/en-ke/live/soccer',
	Origin: 'https://www.betika.com',
};

async function probe() {
	// Try pagination and different limit values to see if more matches exist
	console.log('=== Pagination test ===');
	for (let page = 1; page <= 5; page++) {
		try {
			const r = await axios.get('https://api.betika.com/v1/uo/matches', {
				headers,
				params: { live: 'true', sport_id: 14, limit: 100, page },
				timeout: 8000,
			});
			const d = r.data;
			console.log(`page ${page}: total=${d.meta?.total}, returned=${d.data?.length}`);
			if (!d.data?.length) break;
		} catch (e) {
			console.log(`page ${page}: ERR ${e.response?.status}`);
			break;
		}
	}

	// Try the Sportradar widget API that Betika uses (provider=sr)
	console.log('\n=== Sportradar / alternate sources ===');
	const alts = [
		'https://api.betika.com/v1/uo/matches?live=true&limit=200',
		'https://api.betika.com/v1/uo/matches?live=true&limit=500',
		'https://api.betika.com/v1/uo/matches?live=true&sport_id=14&limit=200',
		'https://api.betika.com/v1/uo/widget/live?sport_id=14',
		'https://api.betika.com/v1/widget/live?sport_id=14',
		'https://api.betika.com/v1/uo/srl/live',          // SRL = simulated
		'https://api.betika.com/v1/uo/matches?live=true&sport_id=14&is_srl=false',
	];
	for (const url of alts) {
		try {
			const r = await axios.get(url, { headers, timeout: 6000 });
			const total = r.data?.meta?.total;
			const count = r.data?.data?.length;
			console.log(`OK [total=${total}, got=${count}]: ${url}`);
		} catch (e) {
			console.log(`${e.response?.status ?? 'NET'}: ${url}`);
		}
	}
}

probe();
