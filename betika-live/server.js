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
    first_goal_min  INTEGER,              -- minute goals first went >0 in 1st half (NULL = no goal yet)
    second_half_goal_min INTEGER,         -- minute first goal scored in 2nd half (NULL = none yet)
    had_red         INTEGER DEFAULT 0,    -- 1 = red card seen at any point
    disqualified    INTEGER DEFAULT 0,    -- 1 = red card ever seen

    notified        INTEGER DEFAULT 0,    -- 1 = push already sent (55min stage)
    notified_ht     INTEGER DEFAULT 0,    -- 1 = halftime alert sent
    notified_55     INTEGER DEFAULT 0,    -- 1 = 55min alert sent
    voided          INTEGER DEFAULT 0,    -- 1 = goal scored 45-55min, bet voided
    updated_at      TEXT
  );

  CREATE TABLE IF NOT EXISTS match_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    match_id    INTEGER NOT NULL,
    event_type  TEXT NOT NULL,           -- 'goal', 'red_card'
    match_time  TEXT,
    score_before TEXT,
    score_after  TEXT,
    detail      TEXT,                    -- extra info (e.g. which team scored)
    recorded_at TEXT NOT NULL
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
	add('second_half_goal_min','INTEGER');
	add('had_red',             'INTEGER DEFAULT 0');
	add('disqualified',        'INTEGER DEFAULT 0');
	add('notified',            'INTEGER DEFAULT 0');
	add('notified_ht',         'INTEGER DEFAULT 0');
	add('notified_55',         'INTEGER DEFAULT 0');
	add('voided',              'INTEGER DEFAULT 0');
	add('set1_score',          'TEXT');
	add('set2_score',          'TEXT');

	// migrate: drop max_yellow column gracefully (SQLite can't DROP COLUMN before 3.35 — just ignore it)
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
    tracked_from_start, first_goal_min, second_half_goal_min, had_red, disqualified,
    notified, notified_ht, notified_55, voided,
    updated_at
  ) VALUES (
    @match_id, @home_team, @away_team, @competition, @category, @start_time, @is_virtual,
    @kicked_off_at, @ended_at,
    @event_status, @match_time, @current_score, @ht_score, @set1_score, @set2_score,
    @home_yellow, @away_yellow, @home_red, @away_red, @home_corners, @away_corners,
    @home_odd, @away_odd, @neutral_odd,
    @tracked_from_start, @first_goal_min, @second_half_goal_min, @had_red, @disqualified,
    0, 0, 0, 0,
    @updated_at
  )
  ON CONFLICT(match_id) DO UPDATE SET
    event_status          = excluded.event_status,
    match_time            = excluded.match_time,
    current_score         = excluded.current_score,
    ht_score              = excluded.ht_score,
    set1_score            = excluded.set1_score,
    set2_score            = excluded.set2_score,
    home_yellow           = excluded.home_yellow,
    away_yellow           = excluded.away_yellow,
    home_red              = excluded.home_red,
    away_red              = excluded.away_red,
    home_corners          = excluded.home_corners,
    away_corners          = excluded.away_corners,
    home_odd              = excluded.home_odd,
    away_odd              = excluded.away_odd,
    neutral_odd           = excluded.neutral_odd,
    kicked_off_at         = COALESCE(matches.kicked_off_at,  excluded.kicked_off_at),
    ended_at              = COALESCE(matches.ended_at,       excluded.ended_at),
    tracked_from_start    = CASE WHEN matches.tracked_from_start = 1 THEN 1 ELSE excluded.tracked_from_start END,
    first_goal_min        = COALESCE(matches.first_goal_min, excluded.first_goal_min),
    second_half_goal_min  = COALESCE(matches.second_half_goal_min, excluded.second_half_goal_min),
    had_red               = CASE WHEN matches.had_red = 1 THEN 1 ELSE excluded.had_red END,
    disqualified          = CASE WHEN matches.disqualified = 1 THEN 1 ELSE excluded.disqualified END,
    updated_at            = excluded.updated_at;
`);

const stmtInsertEvent = db.prepare(`
  INSERT INTO match_events (match_id, event_type, match_time, score_before, score_after, detail, recorded_at)
  VALUES (@match_id, @event_type, @match_time, @score_before, @score_after, @detail, @recorded_at)
`);

// In-memory snapshot: match_id -> { score, home_red, away_red }
const snapshots = new Map();

// ── Helpers ───────────────────────────────────────────────────────────────
const HEADERS = {
	'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
	Accept:       'application/json',
	Referer:      'https://www.betika.com/en-ke/live/soccer',
	Origin:       'https://www.betika.com',
};

// Soccer-only statuses — anything else is a different sport (hockey periods, etc.)
const SOCCER_STATUSES = new Set([
	'1st half', '2nd half', 'half time',
	'ended', 'finished', 'ft', 'complete', 'completed',
	'not started', 'postponed', 'cancelled',
]);

// Non-soccer competition/sport keywords
const NON_SOCCER_PATTERNS = [
	/handball/i, /basketball/i, /\bhockey\b/i, /\btennis\b/i, /volleyball/i,
	/\brugby\b/i, /cricket/i, /baseball/i, /\bnba\b/i, /\bnhl\b/i,
	/\bnfl\b/i, /\bmlb\b/i, /futsal/i, /\behf\b/i, /\biihf\b/i,
	/\bfiba\b/i, /\batp\b/i, /\bwta\b/i,
];

function isSoccer(m) {
	const status = (m.event_status || '').toLowerCase().trim();
	if (!SOCCER_STATUSES.has(status)) return false;
	if (m.sport_id && m.sport_id !== 14) return false;
	const name = (m.competition_name || '') + ' ' + (m.sport_name || '') + ' ' + (m.category || '');
	if (NON_SOCCER_PATTERNS.some(p => p.test(name))) return false;
	// Handball 1st half goes 0→30 min per half — if status='1st half' and mins > 50 it's not soccer
	if (status === '1st half') {
		const mins = parseInt((m.match_time || '0').split(':')[0]) || 0;
		if (mins > 50) return false;
	}
	return true;
}

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
// Returns three stages:
//   'tracking' — 1st half ≤ 10', being tracked, no disqualifying event yet
//   'watching' — 1st half > 10' or half time, still clean, waiting
//   'probets'  — 2nd half ≥ 55', no goal, perfect pro bet
function getProBets() {
	return db.prepare(`
		SELECT *,
		  (SELECT COUNT(*) FROM match_events WHERE match_events.match_id = matches.match_id AND event_type='goal') as total_goals,
		  CASE
		    WHEN event_status = '1st half'
		         AND CAST(SUBSTR(match_time, 1, INSTR(match_time||':', ':') - 1) AS INTEGER) <= 10
		         THEN 'tracking'
		    WHEN event_status = '1st half'
		         AND CAST(SUBSTR(match_time, 1, INSTR(match_time||':', ':') - 1) AS INTEGER) > 10
		         THEN 'watching'
		    WHEN event_status = 'half time'
		         THEN 'watching'
		    WHEN event_status = '2nd half'
		         AND CAST(SUBSTR(match_time, 1, INSTR(match_time||':', ':') - 1) AS INTEGER) >= 55
		         THEN 'probet'
		    ELSE NULL
		  END as stage
		FROM matches
		WHERE
			is_virtual = 0
			AND disqualified = 0
			AND voided = 0
			-- no goal in first 15 mins of 1st half
			AND (first_goal_min IS NULL OR first_goal_min > 15)
			-- no goal in first 15 mins of 2nd half (45+15=60)
			AND (second_half_goal_min IS NULL OR second_half_goal_min > 60)
			-- total goals < 3
			AND (SELECT COUNT(*) FROM match_events WHERE match_events.match_id = matches.match_id AND event_type='goal') < 3
			AND (
			  -- Being tracked: 1st half within first 10 mins
			  (event_status = '1st half' AND CAST(SUBSTR(match_time, 1, INSTR(match_time||':', ':') - 1) AS INTEGER) <= 10)
			  OR
			  -- Watching: 1st half past 10', tracked from start
			  (event_status = '1st half' AND CAST(SUBSTR(match_time, 1, INSTR(match_time||':', ':') - 1) AS INTEGER) > 10 AND tracked_from_start = 1)
			  OR
			  -- Watching: half time, tracked
			  (event_status = 'half time' AND tracked_from_start = 1)
			  OR
			  -- Pro bet: 2nd half >= 55', tracked
			  (event_status = '2nd half' AND CAST(SUBSTR(match_time, 1, INSTR(match_time||':', ':') - 1) AS INTEGER) >= 55 AND tracked_from_start = 1)
			)
		ORDER BY
			CASE
			  WHEN event_status = '2nd half' THEN 0
			  WHEN event_status = 'half time' THEN 1
			  ELSE 2
			END ASC,
			CAST(SUBSTR(match_time, 1, INSTR(match_time||':', ':') - 1) AS INTEGER) DESC
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
	// If a match was in-progress and is now gone from the feed, the game is over — delete immediately
	const trackedInProgress = db.prepare(`
		SELECT match_id FROM matches
		WHERE event_status IN ('1st half', '2nd half', 'half time')
	`).all();

	for (const row of trackedInProgress) {
		if (!liveIds.has(row.match_id)) {
			// Delete events too, then the match
			db.prepare('DELETE FROM match_events WHERE match_id = ?').run(row.match_id);
			stmtDelete.run(row.match_id);
			snapshots.delete(row.match_id);
		}
	}

	// ── Process live matches ──────────────────────────────────────────────
	for (const m of matches) {
		// Skip non-soccer and virtual entirely — don't even store them
		if (!isSoccer(m) || isVirtual(m)) continue;

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

		// ── first_goal_min: minute we first observed goals > 0 in 1st half ─
		let first_goal_min = existing?.first_goal_min ?? null;
		if (first_goal_min === null && goals > 0 && status === '1st half') first_goal_min = min;

		// ── second_half_goal_min: first goal minute in 2nd half ───────────
		let second_half_goal_min = existing?.second_half_goal_min ?? null;
		if (second_half_goal_min === null && goals > 0 && status === '2nd half') {
			// Calculate 2nd half goals from set2_score
			const h2goals = parseGoals(m.set_score?.[1]?.score || m.set2_score || '');
			if (h2goals > 0) second_half_goal_min = min;
		}

		// ── had_red / disqualified: sticky flags — only red cards now ────────
		const had_red      = (existing?.had_red === 1 || reds > 0) ? 1 : 0;
		const disqualified = (existing?.disqualified === 1 || reds > 0) ? 1 : 0;

		// ── Snapshot comparison: detect goals and red cards ───────────────
		const prev = snapshots.get(m.match_id);
		const snap = { score, home_red: m.home_red_card || 0, away_red: m.away_red_card || 0 };
		snapshots.set(m.match_id, snap);

		if (prev) {
			const prevGoals = parseGoals(prev.score);
			const currGoals = parseGoals(score);
			if (currGoals > prevGoals) {
				const [ph, pa] = (prev.score || '0:0').split(':').map(Number);
				const [ch, ca] = (score || '0:0').split(':').map(Number);
				let detail = '';
				if (ch > ph) detail = `${m.home_team} scored`;
				else if (ca > pa) detail = `${m.away_team} scored`;
				else detail = 'Goal';
				stmtInsertEvent.run({
					match_id:     m.match_id,
					event_type:   'goal',
					match_time:   m.match_time || '',
					score_before: prev.score,
					score_after:  score,
					detail:       `${detail} (${score.replace(':', '-')})`,
					recorded_at:  now,
				});
			}
			if (snap.home_red > prev.home_red) {
				stmtInsertEvent.run({
					match_id:    m.match_id,
					event_type:  'red_card',
					match_time:  m.match_time || '',
					score_before: prev.score,
					score_after:  score,
					detail:      `${m.home_team} red card`,
					recorded_at: now,
				});
			}
			if (snap.away_red > prev.away_red) {
				stmtInsertEvent.run({
					match_id:    m.match_id,
					event_type:  'red_card',
					match_time:  m.match_time || '',
					score_before: prev.score,
					score_after:  score,
					detail:      `${m.away_team} red card`,
					recorded_at: now,
				});
			}
		}

		stmtUpsert.run({
			match_id:             m.match_id,
			home_team:            m.home_team,
			away_team:            m.away_team,
			competition:          m.competition_name || '',
			category:             m.category         || '',
			start_time:           m.start_time        || '',
			is_virtual:           0,
			kicked_off_at:        kickedOffAt,
			ended_at:             endedAt,
			event_status:         status,
			match_time:           m.match_time        || '',
			current_score:        score,
			ht_score:             m.ht_score          || '',
			set1_score:           m.set_score?.[0]?.score || '',
			set2_score:           m.set_score?.[1]?.score || '',
			home_yellow:          m.home_yellow_card   || 0,
			away_yellow:          m.away_yellow_card   || 0,
			home_red:             m.home_red_card      || 0,
			away_red:             m.away_red_card      || 0,
			home_corners:         m.home_corners       || 0,
			away_corners:         m.away_corners       || 0,
			home_odd:             m.home_odd           || '',
			away_odd:             m.away_odd           || '',
			neutral_odd:          m.neutral_odd        || '',
			tracked_from_start:   trackedFromStart,
			first_goal_min,
			second_half_goal_min,
			had_red,
			disqualified,
			updated_at: now,
		});
	}

	// ── Base criteria check (shared across all stages) ──────────────────
	// New criteria:
	//   - No goal in first 15 mins of 1st half
	//   - No goal in first 15 mins of 2nd half
	//   - Total goals < 3
	const baseOk = `
		is_virtual = 0
		AND tracked_from_start = 1
		AND disqualified = 0
		AND voided = 0
		AND (first_goal_min IS NULL OR first_goal_min > 15)
		AND (second_half_goal_min IS NULL OR second_half_goal_min > (45 + 15))
		AND (
		  SELECT COALESCE(SUM(CASE WHEN event_type='goal' THEN 1 ELSE 0 END), 0)
		  FROM match_events WHERE match_events.match_id = matches.match_id
		) < 3
	`;

	// ── STAGE 1: Half-time alert ──────────────────────────────────────────
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
			title:    `🟠 Watching at Half Time`,
			body:     `${bet.home_team} ${sc} ${bet.away_team} — ${bet.competition}`,
			url:      '/',
			match_id: bet.match_id,
			stage:    'ht',
		});
	}
	if (htAlerts.length) console.log(`[push-ht] ${htAlerts.length} half-time alert(s)`);

	// ── STAGE 2: Void check (goal scored 45'–55' in 2nd half) ────────────
	const toVoid = db.prepare(`
		SELECT * FROM matches
		WHERE ${baseOk}
		AND notified_ht = 1
		AND event_status = '2nd half'
		AND CAST(SUBSTR(match_time, 1, INSTR(match_time||':', ':') - 1) AS INTEGER) <= 55
		AND set2_score IS NOT NULL AND set2_score != '' AND set2_score != '0:0' AND set2_score != '-:-'
	`).all();

	for (const bet of toVoid) {
		db.prepare('UPDATE matches SET voided = 1 WHERE match_id = ?').run(bet.match_id);
		const sc  = (bet.current_score || '').replace(':', ' - ') || 'vs';
		const min = getMin(bet.match_time);
		await sendPush({
			title:    `❌ Pro Bet Voided — ${min}'`,
			body:     `Goal scored! ${bet.home_team} ${sc} ${bet.away_team} — ${bet.competition}`,
			url:      '/',
			match_id: bet.match_id,
			stage:    'void',
		});
	}
	if (toVoid.length) console.log(`[push-void] ${toVoid.length} bet(s) voided`);

	// ── STAGE 3: GREEN PRO BET alert ─────────────────────────────────────
	// Fires the moment a match becomes a green pro bet:
	// 2nd half >= 55', tracked from start, no early goal, not voided.
	// notified_55 = 0 ensures it fires exactly once.
	const greenAlerts = db.prepare(`
		SELECT * FROM matches
		WHERE ${baseOk}
		AND event_status = '2nd half'
		AND CAST(SUBSTR(match_time, 1, INSTR(match_time||':', ':') - 1) AS INTEGER) >= 55
		AND notified_55 = 0
	`).all();

	for (const bet of greenAlerts) {
		db.prepare('UPDATE matches SET notified_55 = 1, notified = 1 WHERE match_id = ?').run(bet.match_id);
		const sc  = (bet.current_score || '').replace(':', ' - ') || '0 - 0';
		const min = getMin(bet.match_time);
		await sendPush({
			title:    `🟢 Pro Bet — ${min}' No Goal!`,
			body:     `${bet.home_team}  ${sc}  ${bet.away_team}\n${bet.competition}`,
			url:      '/',
			match_id: bet.match_id,
			stage:    'probet',
		});
		console.log(`[push-green] ${bet.home_team} vs ${bet.away_team} @ ${min}'`);
	}
	if (greenAlerts.length) console.log(`[push-green] ${greenAlerts.length} green pro bet alert(s)`);

	// ── Delete completed matches ──────────────────────────────────────────
	// Remove any match with ended_at set (processed and gone from live feed)
	const endedRows = db.prepare(`SELECT match_id FROM matches WHERE ended_at IS NOT NULL`).all();
	for (const row of endedRows) {
		db.prepare('DELETE FROM match_events WHERE match_id = ?').run(row.match_id);
		stmtDelete.run(row.match_id);
		snapshots.delete(row.match_id);
	}

	console.log(
		`[poll] ${new Date().toLocaleTimeString()} ` +
		`live=${matches.filter(m => isSoccer(m) && !isVirtual(m)).length} ` +
		`ht=${htAlerts.length} void=${toVoid.length} green=${greenAlerts.length} ` +
		`deleted=${endedRows.length}`
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
		const had_red        = reds > 0 ? 1 : 0;
		const disqualified   = reds > 0 ? 1 : 0;

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
		res.json({ ok: true, matches: matches.filter(m => isSoccer(m) && !isVirtual(m)), fetched_at: new Date().toISOString() });
	} catch (err) {
		res.status(502).json({ ok: false, error: err.message });
	}
});

app.get('/api/pro-bets', (_req, res) => {
	try {
		const probets = getProBets();
		// Attach goal events to each match
		const stmtGoals = db.prepare(
			"SELECT match_time, detail FROM match_events WHERE match_id = ? AND event_type = 'goal' ORDER BY recorded_at ASC"
		);
		probets.forEach(m => { m.goals = stmtGoals.all(m.match_id); });
		const total = db.prepare('SELECT COUNT(*) as c FROM matches WHERE kicked_off_at IS NOT NULL AND is_virtual = 0').get().c;
		res.json({ ok: true, matches: probets, total, fetched_at: new Date().toISOString() });
	} catch (err) {
		res.status(500).json({ ok: false, error: err.message });
	}
});

app.get('/api/match-events/:match_id', (req, res) => {
	try {
		const events = db.prepare(
			'SELECT * FROM match_events WHERE match_id = ? ORDER BY recorded_at ASC'
		).all(req.params.match_id);
		res.json({ ok: true, events });
	} catch (err) {
		res.status(500).json({ ok: false, error: err.message });
	}
});

app.use(express.static(path.join(__dirname, 'public')));

// ── Start ─────────────────────────────────────────────────────────────────
poll();
setInterval(poll, 15_000);

app.listen(PORT, () => {
	console.log(`\n  ⚽  Betika Live Soccer  →  http://localhost:${PORT}`);
	console.log(`  🎯  Pro Bets           →  http://localhost:${PORT}/probets.html\n`);
});
