const axios = require('axios');

const headers = {
	'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
	Accept: 'application/json',
	Referer: 'https://www.betika.com/en-ke/live/soccer',
	Origin: 'https://www.betika.com',
};

async function probe() {
	const r = await axios.get('https://api.betika.com/v1/uo/matches', {
		headers,
		params: { live: 'true', limit: 500 },
		timeout: 10000,
	});

	const matches = r.data.data;
	console.log('Total live matches:', matches.length);

	// Group by sport
	const bySport = {};
	for (const m of matches) {
		const key = `${m.sport_id}:${m.sport_name}`;
		bySport[key] = (bySport[key] || 0) + 1;
	}
	console.log('\nBy sport:');
	Object.entries(bySport)
		.sort((a, b) => b[1] - a[1])
		.forEach(([k, v]) => console.log(`  ${k.padEnd(35)} ${v}`));

	// Show all Soccer (sport_id=14) matches + any is_srl flags
	const soccer = matches.filter(m => m.sport_id === '14');
	console.log('\nSoccer (14) total:', soccer.length);
	const srlCount = soccer.filter(m => m.is_srl).length;
	console.log('Soccer is_srl=true:', srlCount);
	console.log('Soccer is_srl=false:', soccer.length - srlCount);

	// Check providers
	const providers = {};
	for (const m of soccer) {
		providers[m.provider] = (providers[m.provider] || 0) + 1;
	}
	console.log('Providers:', providers);

	// Sample a few
	console.log('\nSample soccer matches:');
	soccer.slice(0, 5).forEach(m =>
		console.log(`  ${m.home_team} vs ${m.away_team} | start: ${m.start_time} | srl:${m.is_srl} | provider:${m.provider}`)
	);
}

probe().catch(console.error);
