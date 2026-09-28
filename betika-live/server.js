const express  = require('express');
const axios    = require('axios');
const path     = require('path');
const webpush  = require('web-push');
const Database = require('better-sqlite3');

const app  = express();
const PORT = 3000;

app.use(express.json());

// ── VAPID ─────────────────────────────────────────────────────────────────
const VAPID_PUBLIC  = 'BOU9huI1aN_Oq2sWCnxdo4peR1mEMBDNGiITP8OT-sW303PE9OVS8FiGk1c4kovCMkY_GGWSaUL1D-unqwAXxuI';
const VAPID_PRIVATE = 'kGfE-2Uksrztn9CZ-gOwwquc6Dp7GlOGWuXOAaEO2Rk';
webpush.setVapidDetails('mailto:admin@betikalive.local', VAPID_PUBLIC, VAPID_PRIVATE);

// ── SQLite ────────────────────────────────────────────────────────────────
const db = new Database(path.join(__dirname, 'matches.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS matches (
    match_id        INTEGER PRIMARY KEY,
    home_team       TEXT,
    away_team       TEXT,
    competition     TEXT,
    category        TEXT,
    start_time      TEXT,
    is_virtual      INTEGER DEFAULT 0,   -- 1 = zoom/virtual/esport

    -- lifecycle timestamps
    kicked_off_at   TEXT,               -- wall-clock when first seen in 1st half
    ended_at        TEXT,               -- wall-clock when first seen as ended/ft

    -- live state (updated every poll)
    event_status    TEXT,
    match_time      TEXT,
    current_score   TEXT,
    ht_score        TEXT,
    set1_score      TEXT,
    set2_score      TEXT,
    home_yellow     INTEGER DEFAULT 0,
    away_yellow     INTEGER DEFAULT 0,
    home_red        INTEGER DEFAULT 0,
    away_red        INTEGER DEFAULT 0,
    home_corners    INTEGER DEFAULT 0,
    away_corners    INTEGER DEFAULT 0,
    home_odd        TEXT,
    away_odd        TEXT,
    neutral_odd     TEXT,

    -- derived tracking (set once, never overwritten)
    tracked_from_start INTEGER DEFAULT 0, -- 1 = we saw this game from min 0-10
    first_goal_min  INTEGER,              -- minute goals first went >0 (NULL = no goal yet)
    max_yellow      INTEGER DEFAULT 0,    -- highest yellow count seen at any point
    had_red         INTEGER DEFAULT 0,    -- 1 = red card seen at any point
    disqualified    INTEGER DEFAULT 0,    -- 1 = red card OR >=3 yellows ever seen

    notified        INTEGER DEFAULT 0,    -- 1 = push already sent (55min stage)
    notified_ht     INTEGER DEFAULT 0,    -- 1 = halftime alert sent
    notified_55     INTEGER DEFAULT 0,    -- 1 = 55min alert sent
    voided          INTEGER DEFAULT 0,    -- 1 = goal scored 45-55min, bet voided
    updated_at      TEXT
  );

  CREATE TABLE IF NOT EXISTS subscriptions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    endpoint   TEXT UNIQUE,
    sub_json   TEXT NOT NULL,
    created_at TEXT
  );
`);

// ── Migrations for existing DBs ───────────────────────────────────────────
{
	const existing = db.prepare('PRAGMA table_info(matches)').all().map(c => c.name);
	const add = (col, def) => {
		if (!existing.includes(col)) db.exec(`ALTER TABLE matches ADD COLUMN ${col} ${def}`);
	};
	add('is_virtual',          'INTEGER DEFAULT 0');
	add('ended_at',            'TEXT');
	add('tracked_from_start',  'INTEGER DEFAULT 0');
	add('first_goal_min',      'INTEGER');
	add('max_yellow',          'INTEGER DEFAULT 0');
	add('had_red',             'INTEGER DEFAULT 0');
	add('disqualified',        'INTEGER DEFAULT 0');
	add('notified',            'INTEGER DEFAULT 0');
	add('notified_ht',         'INTEGER DEFAULT 0');
	add('notified_55',         'INTEGER DEFAULT 0');
	add('voided',              'INTEGER DEFAULT 0');
	add('set1_score',          'TEXT');
	add('set2_score',          'TEXT');
}

// ── Prepared statements ───────────────────────────────────────────────────
const stmtGet    = db.prepare('SELECT * FROM matches WHERE match_id = ?');
const stmtDelete = db.prepare('DELETE FROM matches WHERE match_id = ?');

const stmtUpsert = db.prepare(`
  INSERT INTO matches (
    match_id, home_team, away_team, competition, category, start_time, is_virtual,
    kicked_off_at, ended_at,
    event_status, match_time, current_score, ht_score, set1_score, set2_score,
    home_yellow, away_yellow, home_red, away_red, home_corners, away_corners,
    home_odd, away_odd, neutral_odd,
    tracked_from_start, first_goal_min, max_yellow, had_red, disqualified,
    notified, notified_ht, notified_55, voided,
    updated_at
  ) VALUES (
    @match_id, @home_team, @away_team, @competition, @category, @start_time, @is_virtual,
    @kicked_off_at, @ended_at,
    @event_status, @match_time, @current_score, @ht_score, @set1_score, @set2_score,
    @home_yellow, @away_yellow, @home_red, @away_red, @home_corners, @away_corners,
    @home_odd, @away_odd, @neutral_odd,
    @tracked_from_start, @first_goal_min, @max_yellow, @had_red, @disqualified,
    0, 0, 0, 0,
    @updated_at
  )
  ON CONFLICT(match_id) DO UPDATE SET
    event_status        = excluded.event_status,
    match_time          = excluded.match_time,
    current_score       = excluded.current_score,
    ht_score            = excluded.ht_score,
    set1_score          = excluded.set1_score,
    set2_score          = excluded.set2_score,
    home_yellow         = excluded.home_yellow,
    away_yellow         = excluded.away_yellow,
    home_red            = excluded.home_red,
    away_red            = excluded.away_red,
    home_corners        = excluded.home_corners,
    away_corners        = excluded.away_corners,
    home_odd            = excluded.home_odd,
    away_odd            = excluded.away_odd,
    neutral_odd         = excluded.neutral_odd,
    kicked_off_at       = COALESCE(matches.kicked_off_at,  excluded.kicked_off_at),
    ended_at            = COALESCE(matches.ended_at,       excluded.ended_at),
    tracked_from_start  = CASE WHEN matches.tracked_from_start = 1 THEN 1 ELSE excluded.tracked_from_start END,
    first_goal_min      = COALESCE(matches.first_goal_min, excluded.first_goal_min),
    max_yellow          = CASE WHEN excluded.max_yellow > matches.max_yellow THEN excluded.max_yellow ELSE matches.max_yellow END,
    had_red             = CASE WHEN matches.had_red = 1 THEN 1 ELSE excluded.had_red END,
    disqualified        = CASE WHEN matches.disqualified = 1 THEN 1 ELSE excluded.disqualified END,
    updated_at          = excluded.updated_at;
`);

// ── Helpers ───────────────────────────────────────────────────────────────
const HEADERS = {
	'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
	Accept:       'application/json',
	Referer:      'https://www.betika.com/en-ke/live/soccer',
	Origin:       'https://www.betika.com',
};

// Competition names that indicate virtual/zoom/esport leagues
const VIRTUAL_PATTERNS = [
	/zoom/i, /virtual/i, /esport/i, /e-sport/i, /esoccer/i, /e-soccer/i,
	/srl/i, /simulated/i, /cyber/i, /igo/i,
];

function isVirtual(m) {
	if (m.is_srl) return true;
	const name = (m.competition_name || '') + ' ' + (m.sport_name || '') + ' ' + (m.category || '');
	return VIRTUAL_PATTERNS.some(p => p.test(name));
}

function parseGoals(s) {
	if (!s || s === '-:-') return 0;
	const [a, b] = s.split(':');
	return (parseInt(a) || 0) + (parseInt(b) || 0);
}

function getMin(match_time) {
	return parseInt((match_time || '0').split(':')[0]) || 0;
}

function isEnded(status) {
	return ['ended', 'finished', 'ft', 'complete', 'completed'].includes(status);
}

// ── Fetch ─────────────────────────────────────────────────────────────────
async function fetchLiveSoccer() {
	const all = [];
	let page = 1, total = null;
	while (true) {
		const res = await axios.get('https://live.betika.com/v1/uo/matches', {
			params:  { sport_id: 14, limit: 100, page },
			headers: HEADERS,
			timeout: 20000,
		});
		const { data } = res.data;
		if (!data || !data.length) break;
		all.push(...data);
		if (total === null) total = parseInt(data[0].total) || 0;
		if (all.length >= total) break;
		page++;
	}
	return all;
}

// ── Push ──────────────────────────────────────────────────────────────────
async function sendPush(payload) {
	const subs = db.prepare('SELECT sub_json FROM subscriptions').all();
	const dead = [];
	await Promise.allSettled(subs.map(async row => {
		try {
			await webpush.sendNotification(JSON.parse(row.sub_json), JSON.stringify(payload));
		} catch (e) {
			if (e.statusCode === 410) dead.push(JSON.parse(row.sub_json).endpoint);
		}
	}));
	if (dead.length) {
		const del = db.prepare('DELETE FROM subscriptions WHERE endpoint = ?');
		dead.forEach(ep => del.run(ep));
	}
}

// ── Pro Bets query ────────────────────────────────────────────────────────
// Returns active pro bets: either at HT (alerted) or in 2nd half 55-90 (not voided)
function getProBets() {
	return db.prepare(`
		SELECT *,
		  CASE
		    WHEN event_status = 'half time'  THEN 'ht'
		    WHEN event_status = '2nd half'   THEN '55'
		    ELSE 'ht'
		  END as stage
		FROM matches
		WHERE
			is_virtual = 0
			AND tracked_from_start = 1
			AND disqualified = 0
			AND (first_goal_min IS NULL OR first_goal_min > 15)
			AND voided = 0
			AND (
			  -- HT stage: alerted at HT, not yet in 2nd half
			  (event_status = 'half time' AND notified_ht = 1)
			  OR
			  -- 55-min stage: in 2nd half 55-90, ht alert already sent
			  (
			    event_status = '2nd half'
			    AND CAST(SUBSTR(match_time, 1, INSTR(match_time, ':') - 1) AS INTEGER) BETWEEN 55 AND 90
			    AND notified_ht = 1
			  )
			)
		ORDER BY
			-- HT first, then by minute descending
			CASE event_status WHEN 'half time' THEN 0 ELSE 1 END ASC,
			CAST(SUBSTR(match_time, 1, INSTR(match_time, ':') - 1) AS INTEGER) DESC
	`).all();
}

// ── Poll loop ─────────────────────────────────────────────────────────────
async function poll() {
	let matches;
	try {
		matches = await fetchLiveSoccer();
	} catch (e) {
		console.error('[poll] fetch error:', e.message);
		return;
	}

	const now      = new Date().toISOString();
	const liveIds  = new Set(matches.map(m => m.match_id));

	// ── Check for matches that have disappeared from the live feed ────────
	// If a match was in DB and is now gone, it likely ended — delete it
	const trackedInProgress = db.prepare(`
		SELECT match_id FROM matches
		WHERE event_status IN ('1st half', '2nd half', 'half time')
	`).all();

	for (const row of trackedInProgress) {
		if (!liveIds.has(row.match_id)) {
			stmtDelete.run(row.match_id);
		}
	}

	// ── Also hard-delete anything marked ended more than 5 mins ago ───────
	db.prepare(`
		DELETE FROM matches
		WHERE ended_at IS NOT NULL
		AND (julianday('now') - julianday(ended_at)) * 86400 > 300
	`).run();

	// ── Process live matches ──────────────────────────────────────────────
	for (const m of matches) {
		// Skip zoom/virtual entirely — don't even store them
		if (isVirtual(m)) continue;

		const status  = (m.event_status || '').toLowerCase().trim();
		const min     = getMin(m.match_time);
		const score   = m.current_score || '0:0';
		const goals   = parseGoals(score);
		const yellows = (m.home_yellow_card || 0) + (m.away_yellow_card || 0);
		const reds    = (m.home_red_card    || 0) + (m.away_red_card    || 0);

		const existing = stmtGet.get(m.match_id);

		// ── kicked_off_at: set when we first see 1st half ────────────────
		const isLive     = status === '1st half' || status === '2nd half' || status === 'half time';
		const kickedOffAt = existing?.kicked_off_at || (status === '1st half' ? now : null);

		// ── ended_at: set when game disappears or ends ───────────────────
		const ended   = isEnded(status);
		const endedAt = existing?.ended_at || (ended ? now : null);

		// ── tracked_from_start: we saw it in 1st half within first 10 mins
		// Once true, stays true forever (sticky)
		const seenEarly = status === '1st half' && min <= 10;
		const trackedFromStart = existing?.tracked_from_start === 1 ? 1 : (seenEarly ? 1 : 0);

		// ── first_goal_min: minute we first observed goals > 0 ───────────
		let first_goal_min = existing?.first_goal_min ?? null;
		if (first_goal_min === null && goals > 0) first_goal_min = min;

		// ── max_yellow: highest yellow count ever seen ────────────────────
		const max_yellow = Math.max(existing?.max_yellow || 0, yellows);

		// ── had_red / disqualified: sticky flags ─────────────────────────
		const had_red      = (existing?.had_red === 1 || reds > 0) ? 1 : 0;
		const disqualified = (existing?.disqualified === 1 || reds > 0 || yellows >= 3) ? 1 : 0;

		stmtUpsert.run({
			match_id:          m.match_id,
			home_team:         m.home_team,
			away_team:         m.away_team,
			competition:       m.competition_name || '',
			category:          m.category         || '',
			start_time:        m.start_time        || '',
			is_virtual:        0,
			kicked_off_at:     kickedOffAt,
			ended_at:          endedAt,
			event_status:      status,
			match_time:        m.match_time        || '',
			current_score:     score,
			ht_score:          m.ht_score          || '',
			set1_score:        m.set_score?.[0]?.score || '',
			set2_score:        m.set_score?.[1]?.score || '',
			home_yellow:       m.home_yellow_card   || 0,
			away_yellow:       m.away_yellow_card   || 0,
			home_red:          m.home_red_card      || 0,
			away_red:          m.away_red_card      || 0,
			home_corners:      m.home_corners       || 0,
			away_corners:      m.away_corners       || 0,
			home_odd:          m.home_odd           || '',
			away_odd:          m.away_odd           || '',
			neutral_odd:       m.neutral_odd        || '',
			tracked_from_start: trackedFromStart,
			first_goal_min,
			max_yellow,
			had_red,
			disqualified,
			updated_at: now,
		});
	}

	// ── Base criteria check (shared across all stages) ──────────────────
	// A match qualifies if tracked from start, not disqualified, first goal > 15' or none
	const baseOk = `
		is_virtual = 0
		AND tracked_from_start = 1
		AND disqualified = 0
		AND (first_goal_min IS NULL OR first_goal_min > 15)
	`;

	// ── STAGE 1: Half-time alert ──────────────────────────────────────────
	// Fires once when match enters half time and criteria are met
	const htAlerts = db.prepare(`
		SELECT * FROM matches
		WHERE ${baseOk}
		AND event_status = 'half time'
		AND notified_ht = 0
	`).all();

	for (const bet of htAlerts) {
		db.prepare('UPDATE matches SET notified_ht = 1 WHERE match_id = ?').run(bet.match_id);
		const sc = (bet.ht_score || bet.current_score || '').replace(':', ' - ') || 'HT';
		await sendPush({
			title:    `🎯 Pro Bet at Half Time`,
			body:     `${bet.home_team} ${sc} ${bet.away_team}\n${bet.competition}`,
			url:      '/probets.html',
			match_id: bet.match_id,
			stage:    'ht',
		});
	}
	if (htAlerts.length) console.log(`[push-ht] ${htAlerts.length} half-time alert(s)`);

	// ── STAGE 2: Void check (goal scored between 45'–55') ────────────────
	// set2_score is the 2nd half running score from the API.
	// If it shows a goal while minute is still <= 55, the bet is voided.
	const toVoid = db.prepare(`
		SELECT * FROM matches
		WHERE ${baseOk}
		AND voided = 0
		AND notified_ht = 1          -- only care about bets that reached HT
		AND event_status = '2nd half'
		AND CAST(SUBSTR(match_time, 1, INSTR(match_time, ':') - 1) AS INTEGER) <= 55
		AND set2_score IS NOT NULL
		AND set2_score != ''
		AND set2_score != '0:0'
		AND set2_score != '-:-'
	`).all();

	for (const bet of toVoid) {
		db.prepare('UPDATE matches SET voided = 1 WHERE match_id = ?').run(bet.match_id);
		const sc  = (bet.current_score || '').replace(':', ' - ') || 'vs';
		const min = getMin(bet.match_time);
		await sendPush({
			title:    `❌ Pro Bet Voided — ${min}'`,
			body:     `Goal scored! ${bet.home_team} ${sc} ${bet.away_team}\n${bet.competition}`,
			url:      '/probets.html',
			match_id: bet.match_id,
			stage:    'void',
		});
	}
	if (toVoid.length) console.log(`[push-void] ${toVoid.length} bet(s) voided`);

	// ── STAGE 3: 55-min alert ─────────────────────────────────────────────
	// Fires once when match is 55'–90', not voided, criteria still met
	const bet55Alerts = db.prepare(`
		SELECT * FROM matches
		WHERE ${baseOk}
		AND event_status = '2nd half'
		AND CAST(SUBSTR(match_time, 1, INSTR(match_time, ':') - 1) AS INTEGER) BETWEEN 55 AND 90
		AND notified_ht = 1          -- must have already sent HT alert
		AND voided = 0               -- not voided by early 2H goal
		AND notified_55 = 0
	`).all();

	for (const bet of bet55Alerts) {
		db.prepare('UPDATE matches SET notified_55 = 1, notified = 1 WHERE match_id = ?').run(bet.match_id);
		const sc  = (bet.current_score || '').replace(':', ' - ') || 'vs';
		const min = getMin(bet.match_time);
		await sendPush({
			title:    `🎯 Pro Bet at ${min}'`,
			body:     `${bet.home_team} ${sc} ${bet.away_team}\n${bet.competition}`,
			url:      '/probets.html',
			match_id: bet.match_id,
			stage:    '55',
		});
	}
	if (bet55Alerts.length) console.log(`[push-55] ${bet55Alerts.length} 55-min alert(s)`);

	// ── Delete completed matches ──────────────────────────────────────────
	// Remove any match where ended_at was set (fully processed and gone)
	const deleted = db.prepare(`
		DELETE FROM matches WHERE ended_at IS NOT NULL
		AND (julianday('now') - julianday(ended_at)) * 86400 > 300
	`).run();

	console.log(
		`[poll] ${new Date().toLocaleTimeString()} ` +
		`live=${matches.filter(m => !isVirtual(m)).length} ` +
		`ht=${htAlerts.length} void=${toVoid.length} 55min=${bet55Alerts.length} ` +
		`deleted=${deleted.changes}`
	);
}

// ── API routes ────────────────────────────────────────────────────────────
app.get('/api/vapid-public', (_req, res) => {
	res.json({ key: VAPID_PUBLIC });
});

app.post('/api/subscribe', (req, res) => {
	const sub = req.body;
	if (!sub?.endpoint) return res.status(400).json({ ok: false, error: 'Missing endpoint' });
	db.prepare(`
		INSERT INTO subscriptions (endpoint, sub_json, created_at)
		VALUES (?, ?, ?)
		ON CONFLICT(endpoint) DO UPDATE SET sub_json = excluded.sub_json
	`).run(sub.endpoint, JSON.stringify(sub), new Date().toISOString());
	res.json({ ok: true });
});

app.delete('/api/subscribe', (req, res) => {
	const { endpoint } = req.body;
	if (endpoint) db.prepare('DELETE FROM subscriptions WHERE endpoint = ?').run(endpoint);
	res.json({ ok: true });
});

// ── Track Pro Bets: scan for matches currently in min 0-5 ────────────────
app.post('/api/track-now', async (_req, res) => {
	let matches;
	try {
		matches = await fetchLiveSoccer();
	} catch (e) {
		return res.status(502).json({ ok: false, error: e.message });
	}

	const now       = new Date().toISOString();
	const newlyLocked = [];

	for (const m of matches) {
		if (isVirtual(m)) continue;

		const status = (m.event_status || '').toLowerCase().trim();
		const min    = getMin(m.match_time);

		// Only care about matches in 1st half within first 5 mins
		if (status !== '1st half' || min > 5) continue;

		const existing = stmtGet.get(m.match_id);

		// Already tracked — skip
		if (existing?.tracked_from_start === 1) continue;

		const score   = m.current_score || '0:0';
		const goals   = parseGoals(score);
		const yellows = (m.home_yellow_card || 0) + (m.away_yellow_card || 0);
		const reds    = (m.home_red_card    || 0) + (m.away_red_card    || 0);

		const first_goal_min = goals > 0 ? min : null;
		const max_yellow     = yellows;
		const had_red        = reds > 0 ? 1 : 0;
		const disqualified   = (reds > 0 || yellows >= 3) ? 1 : 0;

		stmtUpsert.run({
			match_id:           m.match_id,
			home_team:          m.home_team,
			away_team:          m.away_team,
			competition:        m.competition_name || '',
			category:           m.category         || '',
			start_time:         m.start_time        || '',
			is_virtual:         0,
			kicked_off_at:      now,
			ended_at:           null,
			event_status:       status,
			match_time:         m.match_time        || '',
			current_score:      score,
			ht_score:           m.ht_score          || '',
			set1_score:         m.set_score?.[0]?.score || '',
			set2_score:         m.set_score?.[1]?.score || '',
			home_yellow:        yellows,
			away_yellow:        m.away_yellow_card  || 0,
			home_red:           m.home_red_card     || 0,
			away_red:           m.away_red_card     || 0,
			home_corners:       m.home_corners      || 0,
			away_corners:       m.away_corners      || 0,
			home_odd:           m.home_odd          || '',
			away_odd:           m.away_odd          || '',
			neutral_odd:        m.neutral_odd       || '',
			tracked_from_start: 1,
			first_goal_min,
			max_yellow,
			had_red,
			disqualified,
			updated_at: now,
		});

		newlyLocked.push({ match_id: m.match_id, home_team: m.home_team, away_team: m.away_team, min });
	}

	console.log(`[track-now] locked ${newlyLocked.length} new match(es) at minute ≤5`);
	res.json({ ok: true, locked: newlyLocked, count: newlyLocked.length });
});

app.get('/api/live-soccer', async (_req, res) => {
	try {
		const matches = await fetchLiveSoccer();
		// Filter out virtual for the live page too
		res.json({ ok: true, matches: matches.filter(m => !isVirtual(m)), fetched_at: new Date().toISOString() });
	} catch (err) {
		res.status(502).json({ ok: false, error: err.message });
	}
});

app.get('/api/pro-bets', (_req, res) => {
	try {
		const probets = getProBets();
		const total   = db.prepare('SELECT COUNT(*) as c FROM matches WHERE kicked_off_at IS NOT NULL AND is_virtual = 0').get().c;
		res.json({ ok: true, matches: probets, total, fetched_at: new Date().toISOString() });
	} catch (err) {
		res.status(500).json({ ok: false, error: err.message });
	}
});

app.use(express.static(path.join(__dirname, 'public')));

// ── Start ─────────────────────────────────────────────────────────────────
poll();
setInterval(poll, 30_000);

app.listen(PORT, () => {
	console.log(`\n  ⚽  Betika Live Soccer  →  http://localhost:${PORT}`);
	console.log(`  🎯  Pro Bets           →  http://localhost:${PORT}/probets.html\n`);
});
