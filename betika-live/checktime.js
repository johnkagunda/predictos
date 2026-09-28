const axios = require('axios');

axios
	.get('https://api.betika.com/v1/uo/matches', {
		headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://www.betika.com/' },
		params: { live: 'true', sport_id: 14, limit: 100 },
		timeout: 8000,
	})
	.then(r => {
		const now = new Date();
		r.data.data.forEach(m => {
			const start = new Date(m.start_time.replace(' ', 'T') + 'Z');
			const elapsed = Math.floor((now - start) / 60000);
			let period = elapsed < 0 ? 'NOT STARTED' : elapsed <= 45 ? '1st half' : elapsed <= 47 ? 'HT' : elapsed <= 95 ? '2nd HALF' : 'FT';
			console.log(`${String(elapsed).padStart(4)}min [${period.padEnd(11)}] ${m.home_team} vs ${m.away_team}`);
		});
	})
	.catch(console.error);
