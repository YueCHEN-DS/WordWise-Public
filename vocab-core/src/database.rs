use rusqlite::{params, Connection, OptionalExtension};
use std::sync::{Mutex, MutexGuard};

use crate::confusion::{
    calculate_risk, candidate_similarity, is_confident_candidate, is_in_cooldown, is_visible,
    normalize_answer,
};
use crate::error::{VResult, VocabErr};
use crate::mistakes;
use crate::models::{
    AnswerCandidate, ConfusionEdge, ConfusionSignal, ConfusionUpdate, DbOutcome, PracticeMode,
    WordEntry,
};
use crate::sm2::now_iso;

pub static DB: Mutex<Option<Connection>> = Mutex::new(None);

pub type DbGuard = MutexGuard<'static, Option<Connection>>;

pub fn conn() -> VResult<DbGuard> {
    DB.lock().map_err(|_| VocabErr::LockPoisoned)
}

pub fn require(g: &DbGuard) -> VResult<&Connection> {
    g.as_ref().ok_or(VocabErr::NotInit)
}

pub fn require_mut(g: &mut DbGuard) -> VResult<&mut Connection> {
    g.as_mut().ok_or(VocabErr::NotInit)
}

pub fn word_from_row(row: &rusqlite::Row) -> rusqlite::Result<WordEntry> {
    Ok(WordEntry {
        id: row.get(0)?,
        term: row.get(1)?,
        meaning: row.get(2)?,
        correct_count: row.get(3)?,
        incorrect_count: row.get(4)?,
        last_tested: row.get(5)?,
    })
}

pub const WORD_COLS: &str = "id, term, meaning, correct_count, incorrect_count, last_tested";

const SCHEMA_VERSION: i64 = 5;

struct CandidateWord {
    id: i64,
    confidence: f64,
}

pub fn open_db(path: &str) -> VResult<DbOutcome> {
    let mut c = Connection::open(path)?;
    let previous_version: i64 = c.pragma_query_value(None, "user_version", |row| row.get(0))?;

    c.execute_batch(
        "PRAGMA journal_mode=WAL;
         PRAGMA synchronous=NORMAL;
         PRAGMA foreign_keys=ON;",
    )?;

    c.execute_batch(
        "CREATE TABLE IF NOT EXISTS words (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            term TEXT NOT NULL UNIQUE COLLATE NOCASE,
            meaning TEXT NOT NULL,
            correct_count INTEGER NOT NULL DEFAULT 0,
            incorrect_count INTEGER NOT NULL DEFAULT 0,
            last_tested TEXT
        );
        CREATE TABLE IF NOT EXISTS sessions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            date TEXT NOT NULL,
            words_tested INTEGER NOT NULL DEFAULT 0,
            correct INTEGER NOT NULL DEFAULT 0,
            score INTEGER NOT NULL DEFAULT 0
        );",
    )?;

    c.execute_batch(
        "CREATE TABLE IF NOT EXISTS word_scores (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            word_id INTEGER NOT NULL,
            score INTEGER NOT NULL,
            timestamp TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_word_scores_word_id ON word_scores(word_id);
        CREATE INDEX IF NOT EXISTS idx_word_scores_ts ON word_scores(word_id, timestamp DESC);",
    )?;

    c.execute_batch(
        "CREATE TABLE IF NOT EXISTS confusion_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            source_word_id INTEGER NOT NULL,
            answer_text TEXT NOT NULL,
            answer_fingerprint TEXT NOT NULL,
            score INTEGER NOT NULL,
            response_time_ms INTEGER NOT NULL DEFAULT 0,
            candidate_word_id INTEGER,
            candidate_confidence REAL NOT NULL DEFAULT 0.0,
            created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_confusion_events_source
            ON confusion_events(source_word_id, answer_fingerprint, created_at DESC);

        CREATE TABLE IF NOT EXISTS confusion_edges (
            source_word_id INTEGER NOT NULL,
            answer_fingerprint TEXT NOT NULL,
            answer_text TEXT NOT NULL,
            candidate_word_id INTEGER,
            candidate_confidence REAL NOT NULL DEFAULT 0.0,
            occurrence_count INTEGER NOT NULL DEFAULT 0,
            total_score INTEGER NOT NULL DEFAULT 0,
            total_response_time_ms INTEGER NOT NULL DEFAULT 0,
            last_seen TEXT NOT NULL,
            last_practiced TEXT,
            risk_score REAL NOT NULL DEFAULT 0.0,
            PRIMARY KEY (source_word_id, answer_fingerprint)
        );
        CREATE INDEX IF NOT EXISTS idx_confusion_edges_risk
            ON confusion_edges(risk_score DESC, last_seen DESC);",
    )?;

    let migrations_v1 = [
        "ALTER TABLE words ADD COLUMN difficulty_level INTEGER NOT NULL DEFAULT 1",
        "ALTER TABLE words ADD COLUMN sm2_interval REAL NOT NULL DEFAULT 0.0",
        "ALTER TABLE words ADD COLUMN sm2_repetitions INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE words ADD COLUMN sm2_easiness REAL NOT NULL DEFAULT 2.5",
        "ALTER TABLE words ADD COLUMN sm2_next_review TEXT",
    ];
    for sql in &migrations_v1 {
        apply_migration(&c, sql)?;
    }

    let migrations_v2 = [
        "ALTER TABLE words ADD COLUMN forget_count INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE words ADD COLUMN stubborn_factor REAL NOT NULL DEFAULT 0.0",
        "ALTER TABLE word_scores ADD COLUMN response_time_ms INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE word_scores ADD COLUMN user_answer TEXT NOT NULL DEFAULT ''",
    ];
    for sql in &migrations_v2 {
        apply_migration(&c, sql)?;
    }
    apply_migration(
        &c,
        "ALTER TABLE confusion_edges ADD COLUMN last_practiced TEXT",
    )?;

    c.execute_batch(
        "CREATE INDEX IF NOT EXISTS idx_ws_user_answer \
         ON word_scores(word_id, user_answer) WHERE user_answer != '';",
    )?;
    if previous_version < SCHEMA_VERSION {
        migrate_v5(&mut c)?;
    }

    let mut guard = DB.lock().map_err(|_| VocabErr::LockPoisoned)?;
    *guard = Some(c);

    Ok(DbOutcome {
        success: true,
        message: format!("db ready at {path} (schema v{SCHEMA_VERSION})"),
    })
}

fn migrate_v5(c: &mut Connection) -> VResult<()> {
    let migration_time = now_iso();
    let tx = c.transaction()?;
    match tx.execute_batch(
        "ALTER TABLE word_scores ADD COLUMN attempt_source TEXT NOT NULL DEFAULT 'practice'
           CHECK (attempt_source IN ('practice', 'mistake_review'));",
    ) {
        Ok(_) => {}
        Err(error)
            if error
                .to_string()
                .to_lowercase()
                .contains("duplicate column") => {}
        Err(error) => return Err(error.into()),
    }
    tx.execute_batch(
        "CREATE TABLE IF NOT EXISTS mistake_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            word_id INTEGER NOT NULL,
            fingerprint TEXT NOT NULL,
            fingerprint_version INTEGER NOT NULL,
            answer_text TEXT NOT NULL,
            wrong_count INTEGER NOT NULL,
            total_wrong_score INTEGER NOT NULL,
            minimum_score INTEGER NOT NULL,
            last_wrong_score INTEGER NOT NULL,
            total_response_time_ms INTEGER NOT NULL,
            first_wrong_at TEXT NOT NULL,
            last_wrong_at TEXT NOT NULL,
            next_review_at TEXT NOT NULL,
            priority_score REAL NOT NULL,
            review_count INTEGER NOT NULL DEFAULT 0,
            last_reviewed_at TEXT,
            last_review_score INTEGER,
            resolved_at TEXT,
            superseded_at TEXT,
            FOREIGN KEY(word_id) REFERENCES words(id) ON DELETE CASCADE,
            UNIQUE(word_id, fingerprint_version, fingerprint)
        );
        CREATE INDEX IF NOT EXISTS idx_mistake_queue
        ON mistake_items(
          fingerprint_version,
          next_review_at,
          priority_score DESC,
          last_wrong_at DESC,
          id ASC
        )
        WHERE resolved_at IS NULL AND superseded_at IS NULL;
        CREATE INDEX IF NOT EXISTS idx_mistake_due_order
        ON mistake_items(
          fingerprint_version,
          priority_score DESC,
          last_wrong_at DESC,
          id ASC,
          next_review_at
        )
        WHERE resolved_at IS NULL AND superseded_at IS NULL;
        DROP VIEW IF EXISTS reward_eligible_scores;
        CREATE VIEW reward_eligible_scores AS
        SELECT * FROM word_scores WHERE attempt_source = 'practice';",
    )?;
    mistakes::backfill_v1(&tx, &migration_time)?;
    tx.pragma_update(None, "user_version", SCHEMA_VERSION)?;
    tx.commit()?;
    Ok(())
}

fn apply_migration(c: &Connection, sql: &str) -> VResult<()> {
    match c.execute_batch(sql) {
        Ok(_) => Ok(()),
        Err(error)
            if error
                .to_string()
                .to_lowercase()
                .contains("duplicate column") =>
        {
            Ok(())
        }
        Err(error) => Err(error.into()),
    }
}

pub fn recent_scores(c: &Connection, word_id: i64, limit: i64) -> VResult<Vec<i64>> {
    let mut stmt = c.prepare(
        "SELECT score FROM word_scores
         WHERE word_id = ?1 ORDER BY timestamp DESC, id DESC LIMIT ?2",
    )?;
    let rows = stmt.query_map(params![word_id, limit], |row| row.get(0))?;
    Ok(rows.collect::<Result<_, _>>()?)
}

pub fn avg_response_time(c: &Connection, word_id: i64) -> VResult<i64> {
    let average = c.query_row(
        "SELECT COALESCE(AVG(response_time_ms), 0) FROM word_scores \
         WHERE word_id = ?1 AND response_time_ms > 0", // 跳过没传时间的老记录
        params![word_id],
        |row| row.get::<_, f64>(0),
    )?;
    Ok(average.round() as i64)
}

pub fn record_confusion_event(
    c: &Connection,
    source_word_id: i64,
    score: i64,
    response_time_ms: i64,
    user_answer: &str,
    now: &str,
) -> VResult<Option<ConfusionUpdate>> {
    if score >= 60 {
        return Ok(None);
    }

    let fingerprint = normalize_answer(user_answer);
    if fingerprint.chars().count() < 2 {
        return Ok(None);
    }

    let answer_text: String = user_answer.trim().chars().take(200).collect();
    let candidate = find_candidate_word(c, source_word_id, &fingerprint)?;
    let candidate_id = candidate.as_ref().map(|item| item.id);
    let candidate_confidence = candidate
        .as_ref()
        .map(|item| item.confidence)
        .unwrap_or(0.0);

    c.execute(
        "INSERT INTO confusion_events (
            source_word_id, answer_text, answer_fingerprint, score, response_time_ms,
            candidate_word_id, candidate_confidence, created_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            source_word_id,
            answer_text,
            fingerprint,
            score,
            response_time_ms.max(0),
            candidate_id,
            candidate_confidence,
            now
        ],
    )?;

    c.execute(
        "INSERT INTO confusion_edges (
            source_word_id, answer_fingerprint, answer_text, candidate_word_id,
            candidate_confidence, occurrence_count, total_score, total_response_time_ms,
            last_seen, risk_score
        ) VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6, ?7, ?8, 0.0)
        ON CONFLICT(source_word_id, answer_fingerprint) DO UPDATE SET
            answer_text = excluded.answer_text,
            candidate_word_id = CASE
                WHEN excluded.candidate_confidence > confusion_edges.candidate_confidence
                THEN excluded.candidate_word_id
                ELSE confusion_edges.candidate_word_id
            END,
            candidate_confidence = MAX(confusion_edges.candidate_confidence, excluded.candidate_confidence),
            occurrence_count = confusion_edges.occurrence_count + 1,
            total_score = confusion_edges.total_score + excluded.total_score,
            total_response_time_ms = confusion_edges.total_response_time_ms + excluded.total_response_time_ms,
            last_seen = excluded.last_seen",
        params![
            source_word_id,
            fingerprint,
            answer_text,
            candidate_id,
            candidate_confidence,
            score.clamp(0, 100),
            response_time_ms.max(0),
            now
        ],
    )?;

    let (
        occurrence_count,
        total_score,
        total_response_time_ms,
        last_seen,
        stored_candidate_id,
        stored_confidence,
    ): (i64, i64, i64, String, Option<i64>, f64) = c.query_row(
        "SELECT occurrence_count, total_score, total_response_time_ms, last_seen,
                candidate_word_id, candidate_confidence
         FROM confusion_edges
         WHERE source_word_id = ?1 AND answer_fingerprint = ?2",
        params![source_word_id, fingerprint],
        |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
                row.get(5)?,
            ))
        },
    )?;

    let average_score = total_score as f64 / occurrence_count as f64;
    let average_response_time_ms = total_response_time_ms / occurrence_count;
    let risk_score = calculate_risk(
        occurrence_count,
        average_score,
        average_response_time_ms,
        &last_seen,
        now,
    );
    c.execute(
        "UPDATE confusion_edges SET risk_score = ?1
         WHERE source_word_id = ?2 AND answer_fingerprint = ?3",
        params![risk_score, source_word_id, fingerprint],
    )?;

    let candidate_term = match stored_candidate_id {
        Some(id) => c
            .query_row("SELECT term FROM words WHERE id = ?1", params![id], |row| {
                row.get(0)
            })
            .optional()?,
        None => None,
    };

    Ok(Some(ConfusionUpdate {
        answer_fingerprint: fingerprint,
        occurrence_count,
        risk_score,
        is_visible: is_visible(occurrence_count, risk_score),
        candidate_word_id: stored_candidate_id,
        candidate_term,
        candidate_confidence: stored_confidence,
    }))
}

pub fn confusion_map(limit: i64) -> VResult<Vec<ConfusionEdge>> {
    let g = conn()?;
    let c = require(&g)?;
    list_confusion_edges(c, limit.clamp(1, 100))
}

pub fn confusion_detail(
    source_word_id: i64,
    answer_fingerprint: &str,
) -> VResult<Option<ConfusionEdge>> {
    let g = conn()?;
    let c = require(&g)?;
    let mut stmt = c.prepare(&format!(
        "{} WHERE edge.source_word_id = ?1 AND edge.answer_fingerprint = ?2 LIMIT 1",
        confusion_edge_select()
    ))?;
    match stmt.query_row(
        params![source_word_id, answer_fingerprint],
        confusion_edge_from_row,
    ) {
        Ok(mut edge) => {
            refresh_edge_risk(&mut edge, &crate::sm2::now_iso());
            Ok(Some(edge))
        }
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(error) => Err(error.into()),
    }
}

pub fn confusion_signal(
    source_word_id: i64,
    user_answer: &str,
) -> VResult<Option<ConfusionSignal>> {
    let fingerprint = normalize_answer(user_answer);
    if fingerprint.chars().count() < 2 {
        return Ok(None);
    }

    Ok(
        confusion_detail(source_word_id, &fingerprint)?.map(|edge| ConfusionSignal {
            answer_fingerprint: edge.answer_fingerprint,
            occurrence_count: edge.occurrence_count,
            risk_score: edge.risk_score,
            candidate_word_id: edge.candidate_word_id,
            candidate_term: edge.candidate_term,
            candidate_confidence: edge.candidate_confidence,
            is_confirmed: edge.is_confirmed,
        }),
    )
}

pub fn answer_candidate(
    source_word_id: i64,
    user_answer: &str,
) -> VResult<Option<AnswerCandidate>> {
    let fingerprint = normalize_answer(user_answer);
    if fingerprint.chars().count() < 2 {
        return Ok(None);
    }

    let guard = conn()?;
    let connection = require(&guard)?;
    let Some(candidate) = find_candidate_word(connection, source_word_id, &fingerprint)? else {
        return Ok(None);
    };
    let row = connection
        .query_row(
            "SELECT term, meaning FROM words WHERE id = ?1",
            params![candidate.id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()?;

    Ok(row.map(|(term, meaning)| AnswerCandidate {
        word_id: candidate.id,
        term,
        meaning,
        confidence: candidate.confidence,
    }))
}

pub fn confusion_candidate_ids(
    c: &Connection,
    exclude_word_id: i64,
    now: &str,
) -> VResult<Vec<i64>> {
    let mut stmt = c.prepare(
        "SELECT source_word_id, occurrence_count, total_score,
                total_response_time_ms, last_seen,
                CASE
                    WHEN last_practiced IS NOT NULL AND last_practiced > last_seen
                    THEN last_practiced
                    ELSE last_seen
                END AS cooldown_at
         FROM confusion_edges
         WHERE occurrence_count >= ?1 AND source_word_id != ?2
         ORDER BY risk_score DESC, last_seen DESC
         LIMIT 200",
    )?;
    let rows = stmt.query_map(
        params![crate::confusion::MIN_VISIBLE_OCCURRENCES, exclude_word_id],
        |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
            ))
        },
    )?;
    let mut candidates = Vec::new();
    for row in rows {
        let (word_id, count, total_score, total_time, last_seen, cooldown_at) = row?;
        let risk = calculate_risk(
            count,
            total_score as f64 / count.max(1) as f64,
            total_time / count.max(1),
            &last_seen,
            now,
        );
        if risk >= crate::confusion::MIN_VISIBLE_RISK && !is_in_cooldown(&cooldown_at, now) {
            candidates.push((word_id, risk));
        }
    }
    candidates.sort_by(|left, right| right.1.total_cmp(&left.1));
    Ok(candidates.into_iter().map(|(word_id, _)| word_id).collect())
}

pub fn mark_confusion_practiced(c: &Connection, word_id: i64, now: &str) -> VResult<()> {
    c.execute(
        "UPDATE confusion_edges SET last_practiced=?1 WHERE source_word_id=?2",
        params![now, word_id],
    )?;
    Ok(())
}

fn find_candidate_word(
    c: &Connection,
    source_word_id: i64,
    answer_fingerprint: &str,
) -> VResult<Option<CandidateWord>> {
    let mut stmt = c.prepare("SELECT id, meaning FROM words WHERE id != ?1 ORDER BY id")?;
    let mut best: Option<CandidateWord> = None;
    for row in stmt.query_map(params![source_word_id], |row| {
        Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
    })? {
        let (id, meaning) = row?;
        let confidence = candidate_similarity(answer_fingerprint, &meaning);
        if !is_confident_candidate(confidence) {
            continue;
        }
        if best
            .as_ref()
            .is_none_or(|item| confidence > item.confidence)
        {
            best = Some(CandidateWord { id, confidence });
        }
    }
    Ok(best)
}

fn list_confusion_edges(c: &Connection, limit: i64) -> VResult<Vec<ConfusionEdge>> {
    let mut stmt = c.prepare(&format!(
        "{} WHERE edge.occurrence_count >= ?1
         ORDER BY edge.risk_score DESC, edge.last_seen DESC LIMIT ?2",
        confusion_edge_select()
    ))?;
    let rows = stmt.query_map(
        params![
            crate::confusion::MIN_VISIBLE_OCCURRENCES,
            (limit * 5).clamp(limit, 500)
        ],
        confusion_edge_from_row,
    )?;
    let now = crate::sm2::now_iso();
    let mut edges = Vec::new();
    for row in rows {
        let mut edge = row?;
        refresh_edge_risk(&mut edge, &now);
        if edge.risk_score >= crate::confusion::MIN_VISIBLE_RISK {
            edges.push(edge);
        }
    }
    edges.sort_by(|left, right| right.risk_score.total_cmp(&left.risk_score));
    edges.truncate(limit as usize);
    Ok(edges)
}

fn refresh_edge_risk(edge: &mut ConfusionEdge, now: &str) {
    edge.risk_score = calculate_risk(
        edge.occurrence_count,
        edge.average_score,
        edge.average_response_time_ms,
        &edge.last_seen,
        now,
    );
}

fn confusion_edge_select() -> &'static str {
    "SELECT edge.source_word_id, source.term, source.meaning, edge.answer_text,
            edge.answer_fingerprint, edge.candidate_word_id, candidate.term, candidate.meaning,
            edge.candidate_confidence, edge.occurrence_count, edge.risk_score,
            edge.total_score, edge.total_response_time_ms, edge.last_seen
     FROM confusion_edges AS edge
     INNER JOIN words AS source ON source.id = edge.source_word_id
     LEFT JOIN words AS candidate ON candidate.id = edge.candidate_word_id"
}

fn confusion_edge_from_row(row: &rusqlite::Row) -> rusqlite::Result<ConfusionEdge> {
    let occurrence_count: i64 = row.get(9)?;
    let total_score: i64 = row.get(11)?;
    let total_response_time_ms: i64 = row.get(12)?;
    let candidate_word_id: Option<i64> = row.get(5)?;
    let candidate_confidence: f64 = row.get(8)?;
    Ok(ConfusionEdge {
        source_word_id: row.get(0)?,
        source_term: row.get(1)?,
        source_meaning: row.get(2)?,
        answer_text: row.get(3)?,
        answer_fingerprint: row.get(4)?,
        candidate_word_id,
        candidate_term: row.get(6)?,
        candidate_meaning: row.get(7)?,
        candidate_confidence,
        occurrence_count,
        risk_score: row.get(10)?,
        average_score: total_score as f64 / occurrence_count.max(1) as f64,
        average_response_time_ms: total_response_time_ms / occurrence_count.max(1),
        last_seen: row.get(13)?,
        is_confirmed: occurrence_count >= crate::confusion::MIN_VISIBLE_OCCURRENCES
            && candidate_word_id.is_some()
            && is_confident_candidate(candidate_confidence),
    })
}

pub fn add_word(term: &str, meaning: &str) -> VResult<Option<WordEntry>> {
    let term = term.trim();
    if term.is_empty() {
        return Ok(None);
    }
    let mut g = conn()?;
    let c = require_mut(&mut g)?;
    c.execute(
        "INSERT OR IGNORE INTO words (term, meaning) VALUES (?1, ?2)",
        params![term, meaning.trim()],
    )?;
    let mut stmt = c.prepare(&format!("SELECT {WORD_COLS} FROM words WHERE term = ?1"))?;
    Ok(stmt.query_row(params![term], word_from_row).optional()?)
}

pub fn delete_word(id: i64) -> VResult<DbOutcome> {
    let mut g = conn()?;
    let c = require_mut(&mut g)?;
    let tx = c.transaction()?;
    tx.execute("DELETE FROM word_scores WHERE word_id=?1", params![id])?;
    tx.execute(
        "DELETE FROM confusion_events WHERE source_word_id=?1",
        params![id],
    )?;
    tx.execute(
        "DELETE FROM confusion_edges WHERE source_word_id=?1",
        params![id],
    )?;
    tx.execute(
        "UPDATE confusion_events
         SET candidate_word_id=NULL, candidate_confidence=0.0
         WHERE candidate_word_id=?1",
        params![id],
    )?;
    tx.execute(
        "UPDATE confusion_edges
         SET candidate_word_id=NULL, candidate_confidence=0.0
         WHERE candidate_word_id=?1",
        params![id],
    )?;
    tx.execute("DELETE FROM words WHERE id=?1", params![id])?;
    tx.commit()?;
    Ok(DbOutcome {
        success: true,
        message: "deleted".into(),
    })
}

pub fn all_words() -> VResult<Vec<WordEntry>> {
    let g = conn()?;
    let c = require(&g)?;
    let mut stmt = c.prepare(&format!("SELECT {WORD_COLS} FROM words ORDER BY term"))?;
    let rows = stmt.query_map([], word_from_row)?;
    let words = rows.collect::<Result<_, _>>()?;
    Ok(words)
}

pub fn find_word(term: &str) -> VResult<Option<WordEntry>> {
    let g = conn()?;
    let c = require(&g)?;
    let mut stmt = c.prepare(&format!("SELECT {WORD_COLS} FROM words WHERE term = ?1"))?;
    Ok(stmt.query_row(params![term], word_from_row).optional()?)
}

pub fn pick_batch(limit: i64, mode: PracticeMode, offset: i64) -> VResult<Vec<WordEntry>> {
    let g = conn()?;
    let c = require(&g)?;
    let sql = match mode {
        PracticeMode::Sequential => {
            format!("SELECT {WORD_COLS} FROM words ORDER BY id LIMIT ?1 OFFSET ?2")
        }
        PracticeMode::Hard => {
            // 错误率排序，max(total,1) 防除零（刚导入的词没答过）
            format!(
                "SELECT {WORD_COLS} FROM words \
                 ORDER BY (incorrect_count * 1.0 / MAX(correct_count + incorrect_count, 1)) DESC \
                 LIMIT ?1"
            )
        }
        PracticeMode::Random => {
            format!("SELECT {WORD_COLS} FROM words ORDER BY RANDOM() LIMIT ?1")
        }
    };
    let mut stmt = c.prepare(&sql)?;
    let rows = match mode {
        PracticeMode::Sequential => stmt.query_map(params![limit, offset], word_from_row)?,
        _ => stmt.query_map(params![limit], word_from_row)?,
    };
    let words = rows.collect::<Result<_, _>>()?;
    Ok(words)
}

pub fn bump_score(id: i64, correct: bool) -> VResult<DbOutcome> {
    let mut g = conn()?;
    let c = require_mut(&mut g)?;
    let now = now_iso();
    if correct {
        c.execute(
            "UPDATE words SET correct_count=correct_count+1, last_tested=?1 WHERE id=?2",
            params![now, id],
        )?;
    } else {
        c.execute(
            "UPDATE words SET incorrect_count=incorrect_count+1, last_tested=?1 WHERE id=?2",
            params![now, id],
        )?;
    }
    Ok(DbOutcome {
        success: true,
        message: "ok".into(),
    })
}

pub fn log_session(tested: i64, correct: i64, score: i64) -> VResult<DbOutcome> {
    let mut g = conn()?;
    let c = require_mut(&mut g)?;
    let now = now_iso();
    c.execute(
        "INSERT INTO sessions (date, words_tested, correct, score) VALUES (?1, ?2, ?3, ?4)",
        params![now, tested, correct, score],
    )?;
    Ok(DbOutcome {
        success: true,
        message: "saved".into(),
    })
}

pub fn word_count() -> VResult<i64> {
    let g = conn()?;
    let c = require(&g)?;
    Ok(c.query_row("SELECT COUNT(*) FROM words", [], |r| r.get(0))?)
}

pub fn dump_json() -> VResult<String> {
    let g = conn()?;
    let c = require(&g)?;
    let mut stmt = c.prepare("SELECT term, meaning FROM words ORDER BY term")?;
    let rows = stmt.query_map([], |row| {
        Ok(serde_json::json!({
            "term": row.get::<_, String>(0)?,
            "meaning": row.get::<_, String>(1)?
        }))
    })?;
    let words = rows.collect::<Result<Vec<_>, _>>()?;
    Ok(serde_json::to_string(&words)?)
}

pub fn update_forget_stats(c: &Connection, word_id: i64, score: i64) -> VResult<()> {
    if score < 60 {
        c.execute(
            "UPDATE words SET forget_count = forget_count + 1 WHERE id = ?1",
            params![word_id],
        )?;
    }

    let (forget_cnt, correct_cnt, incorrect_cnt): (i64, i64, i64) = c.query_row(
        "SELECT forget_count, correct_count, incorrect_count FROM words WHERE id = ?1",
        params![word_id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    )?;

    let total = correct_cnt + incorrect_cnt;
    let factor = crate::sm2::calc_stubborn_factor(forget_cnt, total);

    c.execute(
        "UPDATE words SET stubborn_factor = ?1 WHERE id = ?2",
        params![factor, word_id],
    )?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    static TEST_DB_LOCK: Mutex<()> = Mutex::new(());

    fn temp_db(label: &str) -> std::path::PathBuf {
        let suffix = chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default();
        std::env::temp_dir().join(format!("wordwise-{label}-{suffix}.db"))
    }

    #[test]
    fn stores_repeated_errors_as_a_confirmed_confusion_edge() {
        let _lock = TEST_DB_LOCK.lock().unwrap();
        let path = temp_db("confusion");
        open_db(path.to_str().unwrap()).unwrap();

        let source = add_word("abandon", "放弃；抛弃").unwrap().unwrap();
        let candidate = add_word("indulge", "放纵").unwrap().unwrap();
        let now = crate::sm2::now_iso();

        {
            let guard = conn().unwrap();
            let connection = require(&guard).unwrap();
            record_confusion_event(connection, source.id, 10, 18_000, "放纵", &now).unwrap();
            record_confusion_event(connection, source.id, 20, 21_000, "放纵", &now).unwrap();
            record_confusion_event(connection, source.id, 15, 12_000, "允许", &now).unwrap();
            record_confusion_event(connection, source.id, 25, 14_000, "允许", &now).unwrap();
        }

        let map = confusion_map(10).unwrap();
        assert_eq!(map.len(), 2);
        let confirmed = map.iter().find(|edge| edge.answer_text == "放纵").unwrap();
        assert_eq!(confirmed.source_term, "abandon");
        assert_eq!(confirmed.candidate_term.as_deref(), Some("indulge"));
        assert!(confirmed.is_confirmed);
        assert!(confirmed.risk_score >= crate::confusion::MIN_VISIBLE_RISK);

        let evidence = map.iter().find(|edge| edge.answer_text == "允许").unwrap();
        assert!(evidence.candidate_word_id.is_none());
        assert!(!evidence.is_confirmed);

        delete_word(candidate.id).unwrap();
        let detail = confusion_detail(source.id, &normalize_answer("放纵"))
            .unwrap()
            .unwrap();
        assert!(detail.candidate_word_id.is_none());
        assert_eq!(detail.occurrence_count, 2);

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn confusion_signal_is_read_only() {
        let _lock = TEST_DB_LOCK.lock().unwrap();
        let path = temp_db("signal");
        open_db(path.to_str().unwrap()).unwrap();

        let source = add_word("abandon", "放弃；抛弃").unwrap().unwrap();
        add_word("indulge", "放纵").unwrap().unwrap();
        let now = crate::sm2::now_iso();
        {
            let guard = conn().unwrap();
            let connection = require(&guard).unwrap();
            record_confusion_event(connection, source.id, 15, 12_000, "放纵", &now).unwrap();
            record_confusion_event(connection, source.id, 20, 15_000, "放纵", &now).unwrap();
        }

        let before = {
            let guard = conn().unwrap();
            require(&guard)
                .unwrap()
                .query_row("SELECT COUNT(*) FROM confusion_events", [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap()
        };
        let signal = confusion_signal(source.id, "  放纵！ ").unwrap().unwrap();
        let after = {
            let guard = conn().unwrap();
            require(&guard)
                .unwrap()
                .query_row("SELECT COUNT(*) FROM confusion_events", [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap()
        };

        assert_eq!(signal.occurrence_count, 2);
        assert_eq!(signal.candidate_term.as_deref(), Some("indulge"));
        assert!(signal.is_confirmed);
        assert_eq!(before, after);

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn answer_candidate_does_not_create_learning_history() {
        let _lock = TEST_DB_LOCK.lock().unwrap();
        let path = temp_db("answer-candidate");
        open_db(path.to_str().unwrap()).unwrap();

        let source = add_word("affect", "影响").unwrap().unwrap();
        let candidate = add_word("effect", "效果；结果").unwrap().unwrap();
        let match_result = answer_candidate(source.id, "效果").unwrap().unwrap();

        assert_eq!(match_result.word_id, candidate.id);
        assert_eq!(match_result.term, "effect");
        assert!(match_result.confidence >= crate::confusion::CANDIDATE_CONFIDENCE);
        let guard = conn().unwrap();
        let count: i64 = require(&guard)
            .unwrap()
            .query_row("SELECT COUNT(*) FROM confusion_events", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(count, 0);
        drop(guard);

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn upgrades_beta_history_to_schema_v5_atomically() {
        let _lock = TEST_DB_LOCK.lock().unwrap();
        let path = temp_db("migration");
        {
            let legacy = Connection::open(&path).unwrap();
            legacy
                .execute_batch(
                    "CREATE TABLE words (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        term TEXT NOT NULL UNIQUE COLLATE NOCASE,
                        meaning TEXT NOT NULL,
                        correct_count INTEGER NOT NULL DEFAULT 0,
                        incorrect_count INTEGER NOT NULL DEFAULT 0,
                        last_tested TEXT
                    );
                    CREATE TABLE sessions (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        date TEXT NOT NULL,
                        words_tested INTEGER NOT NULL DEFAULT 0,
                        correct INTEGER NOT NULL DEFAULT 0,
                        score INTEGER NOT NULL DEFAULT 0
                    );
                    CREATE TABLE word_scores (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        word_id INTEGER NOT NULL,
                        score INTEGER NOT NULL,
                        timestamp TEXT NOT NULL,
                        response_time_ms INTEGER NOT NULL DEFAULT 0,
                        user_answer TEXT NOT NULL DEFAULT ''
                    );
                    INSERT INTO words (id, term, meaning) VALUES (1, 'run', '跑；运行');
                    INSERT INTO word_scores (
                        word_id, score, timestamp, response_time_ms, user_answer
                    ) VALUES
                        (1, 20, '2026-01-01T10:00:00+00:00', 1000, ' vt. vi. Run！ '),
                        (1, 10, '2026-01-02T10:00:00+00:00', 2000, 'run');
                    PRAGMA user_version = 4;",
                )
                .unwrap();
        }

        open_db(path.to_str().unwrap()).unwrap();
        let guard = conn().unwrap();
        let connection = require(&guard).unwrap();
        let version: i64 = connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(version, SCHEMA_VERSION);
        assert!(connection
            .prepare(
                "SELECT response_time_ms, user_answer, attempt_source FROM word_scores LIMIT 0"
            )
            .is_ok());
        assert!(connection
            .prepare("SELECT risk_score, last_practiced FROM confusion_edges LIMIT 0")
            .is_ok());
        let migrated: (String, i64, i64, i64, i64, String) = connection
            .query_row(
                "SELECT fingerprint, wrong_count, total_wrong_score, minimum_score,
                        total_response_time_ms, answer_text FROM mistake_items",
                [],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                    ))
                },
            )
            .unwrap();
        assert_eq!(migrated, ("run".into(), 2, 30, 10, 3000, "run".into()));
        let reward_rows: i64 = connection
            .query_row("SELECT COUNT(*) FROM reward_eligible_scores", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(reward_rows, 2);
        drop(guard);

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn mistake_upsert_cooldown_resolution_and_rewards_follow_contract() {
        let _lock = TEST_DB_LOCK.lock().unwrap();
        let path = temp_db("mistake-contract");
        open_db(path.to_str().unwrap()).unwrap();
        let word = add_word("abandon", "放弃；抛弃").unwrap().unwrap();

        let first =
            crate::adaptive::record_score(word.id, 10, 1000, " v. 放 弃！ ", "practice", None)
                .unwrap();
        let second =
            crate::adaptive::record_score(word.id, 20, 2000, "放弃", "practice", None).unwrap();
        assert!(first.reward_eligible && second.reward_eligible);
        assert_eq!(first.mistake_id, second.mistake_id);
        let mistake_id = second.mistake_id.unwrap();

        {
            let guard = conn().unwrap();
            let connection = require(&guard).unwrap();
            let values: (i64, i64, i64, i64, i64, String) = connection
                .query_row(
                    "SELECT wrong_count, total_wrong_score, minimum_score, last_wrong_score,
                            total_response_time_ms, answer_text FROM mistake_items WHERE id=?1",
                    params![mistake_id],
                    |row| {
                        Ok((
                            row.get(0)?,
                            row.get(1)?,
                            row.get(2)?,
                            row.get(3)?,
                            row.get(4)?,
                            row.get(5)?,
                        ))
                    },
                )
                .unwrap();
            assert_eq!(values, (2, 30, 10, 20, 3000, "放弃".into()));
        }

        let wrong_review = crate::adaptive::record_score(
            word.id,
            30,
            3000,
            "放弃",
            "mistake_review",
            Some(mistake_id),
        )
        .unwrap();
        assert!(!wrong_review.reward_eligible);
        {
            let guard = conn().unwrap();
            let connection = require(&guard).unwrap();
            let (wrong_count, review_count, next_review_at): (i64, i64, String) = connection
                .query_row(
                    "SELECT wrong_count, review_count, next_review_at FROM mistake_items WHERE id=?1",
                    params![mistake_id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .unwrap();
            assert_eq!((wrong_count, review_count), (3, 1));
            assert!(next_review_at > crate::sm2::now_iso());
        }

        let correct_review = crate::adaptive::record_score(
            word.id,
            90,
            500,
            "放弃",
            "mistake_review",
            Some(mistake_id),
        )
        .unwrap();
        assert!(!correct_review.reward_eligible);
        assert!(correct_review.mistake_resolved);
        let guard = conn().unwrap();
        let (review_count, resolved_at): (i64, Option<String>) = require(&guard)
            .unwrap()
            .query_row(
                "SELECT review_count, resolved_at FROM mistake_items WHERE id=?1",
                params![mistake_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(review_count, 2);
        assert!(resolved_at.is_some());
        drop(guard);

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn indexed_mistake_queue_handles_one_hundred_thousand_rows_under_budget() {
        let _lock = TEST_DB_LOCK.lock().unwrap();
        let path = temp_db("mistake-benchmark");
        open_db(path.to_str().unwrap()).unwrap();
        let word = add_word("benchmark", "基准").unwrap().unwrap();
        let now = crate::sm2::now_iso();
        {
            let guard = conn().unwrap();
            let connection = require(&guard).unwrap();
            connection
                .execute(
                    "WITH RECURSIVE sequence(x) AS (
                       VALUES(1) UNION ALL SELECT x + 1 FROM sequence WHERE x < 100000
                     )
                     INSERT INTO mistake_items (
                       word_id, fingerprint, fingerprint_version, answer_text, wrong_count,
                       total_wrong_score, minimum_score, last_wrong_score, total_response_time_ms,
                       first_wrong_at, last_wrong_at, next_review_at, priority_score, review_count
                     )
                     SELECT ?1, printf('f%06d', x), 1, printf('answer-%d', x), 1,
                            x % 60, x % 60, x % 60, x % 30000,
                            ?2, ?2, ?2, CAST(x % 100 AS REAL), 0
                     FROM sequence",
                    params![word.id, now],
                )
                .unwrap();

            let mut plan = connection
                .prepare(
                    "EXPLAIN QUERY PLAN
                     SELECT id FROM mistake_items INDEXED BY idx_mistake_due_order
                     WHERE fingerprint_version = 1 AND resolved_at IS NULL
                       AND superseded_at IS NULL AND next_review_at <= ?1 AND id != -1
                     ORDER BY priority_score DESC, last_wrong_at DESC, id ASC LIMIT 1",
                )
                .unwrap();
            let details: Vec<String> = plan
                .query_map(params![now], |row| row.get(3))
                .unwrap()
                .collect::<Result<_, _>>()
                .unwrap();
            assert!(details
                .iter()
                .any(|detail| detail.contains("idx_mistake_due_order")));
            let required_index: i64 = connection
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master
                     WHERE type='index' AND name='idx_mistake_queue'",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(required_index, 1);

            let mut timings = Vec::new();
            for _ in 0..25 {
                let started = std::time::Instant::now();
                let item = crate::mistakes::next_mistake(connection, None, &now).unwrap();
                assert!(item.is_some());
                timings.push(started.elapsed());
            }
            timings.sort();
            let p95 = timings[((timings.len() as f64 * 0.95).ceil() as usize) - 1];
            assert!(p95.as_millis() < 20, "queue p95 was {p95:?}");
        }
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn scoring_transaction_rolls_back_at_each_storage_boundary() {
        let _lock = TEST_DB_LOCK.lock().unwrap();
        let path = temp_db("atomic-failures");
        open_db(path.to_str().unwrap()).unwrap();
        let word = add_word("rollback", "回滚").unwrap().unwrap();

        let snapshot = || {
            let guard = conn().unwrap();
            require(&guard)
                .unwrap()
                .query_row(
                    "SELECT
                       (SELECT COUNT(*) FROM word_scores WHERE word_id=?1),
                       correct_count, incorrect_count,
                       (SELECT COUNT(*) FROM confusion_events WHERE source_word_id=?1),
                       (SELECT COUNT(*) FROM mistake_items WHERE word_id=?1)
                     FROM words WHERE id=?1",
                    params![word.id],
                    |row| {
                        Ok((
                            row.get::<_, i64>(0)?,
                            row.get::<_, i64>(1)?,
                            row.get::<_, i64>(2)?,
                            row.get::<_, i64>(3)?,
                            row.get::<_, i64>(4)?,
                        ))
                    },
                )
                .unwrap()
        };

        for (name, trigger) in [
            (
                "fail_score_history",
                "CREATE TRIGGER fail_score_history BEFORE INSERT ON word_scores
                 BEGIN SELECT RAISE(ABORT, 'score history failure'); END;",
            ),
            (
                "fail_mastery_update",
                "CREATE TRIGGER fail_mastery_update BEFORE UPDATE ON words
                 BEGIN SELECT RAISE(ABORT, 'mastery failure'); END;",
            ),
            (
                "fail_confusion_write",
                "CREATE TRIGGER fail_confusion_write BEFORE INSERT ON confusion_events
                 BEGIN SELECT RAISE(ABORT, 'confusion failure'); END;",
            ),
            (
                "fail_mistake_upsert",
                "CREATE TRIGGER fail_mistake_upsert BEFORE INSERT ON mistake_items
                 BEGIN SELECT RAISE(ABORT, 'mistake failure'); END;",
            ),
        ] {
            let before = snapshot();
            {
                let guard = conn().unwrap();
                require(&guard).unwrap().execute_batch(trigger).unwrap();
            }
            assert!(
                crate::adaptive::record_score(word.id, 10, 1000, "错误", "practice", None,)
                    .is_err()
            );
            {
                let guard = conn().unwrap();
                require(&guard)
                    .unwrap()
                    .execute_batch(&format!("DROP TRIGGER {name}"))
                    .unwrap();
            }
            assert_eq!(snapshot(), before, "partial write survived {name}");
        }

        let seeded =
            crate::adaptive::record_score(word.id, 10, 1000, "错误", "practice", None).unwrap();
        let mistake_id = seeded.mistake_id.unwrap();
        let before_review = snapshot();
        {
            let guard = conn().unwrap();
            require(&guard)
                .unwrap()
                .execute_batch(
                    "CREATE TRIGGER fail_review_resolution
                     BEFORE UPDATE OF resolved_at ON mistake_items
                     WHEN NEW.resolved_at IS NOT NULL
                     BEGIN SELECT RAISE(ABORT, 'resolution failure'); END;",
                )
                .unwrap();
        }
        assert!(crate::adaptive::record_score(
            word.id,
            90,
            500,
            "回滚",
            "mistake_review",
            Some(mistake_id),
        )
        .is_err());
        assert_eq!(snapshot(), before_review);
        {
            let guard = conn().unwrap();
            let connection = require(&guard).unwrap();
            let state: (i64, Option<String>) = connection
                .query_row(
                    "SELECT review_count, resolved_at FROM mistake_items WHERE id=?1",
                    params![mistake_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .unwrap();
            assert_eq!(state, (0, None));
            connection
                .execute_batch("DROP TRIGGER fail_review_resolution")
                .unwrap();
        }
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn adaptive_picker_exposes_each_selection_reason_and_cooldown() {
        let _lock = TEST_DB_LOCK.lock().unwrap();
        let mut paths = Vec::new();

        let due_path = temp_db("due");
        paths.push(due_path.clone());
        open_db(due_path.to_str().unwrap()).unwrap();
        let due = add_word("due", "到期").unwrap().unwrap();
        {
            let guard = conn().unwrap();
            require(&guard)
                .unwrap()
                .execute(
                    "UPDATE words SET sm2_repetitions=1, sm2_next_review=?1 WHERE id=?2",
                    params![crate::sm2::days_later(-1.0), due.id],
                )
                .unwrap();
        }
        assert_eq!(
            crate::adaptive::pick_next(3, None)
                .unwrap()
                .unwrap()
                .selection_reason,
            "due_review"
        );

        let confusion_path = temp_db("risk");
        paths.push(confusion_path.clone());
        open_db(confusion_path.to_str().unwrap()).unwrap();
        let source = add_word("source", "来源").unwrap().unwrap();
        let candidate = add_word("candidate", "候选").unwrap().unwrap();
        let old = crate::sm2::days_later(-1.0);
        {
            let guard = conn().unwrap();
            let connection = require(&guard).unwrap();
            record_confusion_event(connection, source.id, 10, 20_000, "候选", &old).unwrap();
            record_confusion_event(connection, source.id, 20, 20_000, "候选", &old).unwrap();
        }
        assert_eq!(
            crate::adaptive::pick_next(3, Some(candidate.id))
                .unwrap()
                .unwrap()
                .selection_reason,
            "confusion_risk"
        );
        assert_eq!(
            crate::adaptive::pick_next(3, Some(candidate.id))
                .unwrap()
                .unwrap()
                .selection_reason,
            "difficulty_match"
        );

        let cooldown_path = temp_db("cooldown");
        paths.push(cooldown_path.clone());
        open_db(cooldown_path.to_str().unwrap()).unwrap();
        let source = add_word("source", "来源").unwrap().unwrap();
        let candidate = add_word("candidate", "候选").unwrap().unwrap();
        let now = crate::sm2::now_iso();
        {
            let guard = conn().unwrap();
            let connection = require(&guard).unwrap();
            connection
                .execute(
                    "UPDATE words SET difficulty_level=3 WHERE id=?1",
                    params![source.id],
                )
                .unwrap();
            record_confusion_event(connection, source.id, 10, 20_000, "候选", &now).unwrap();
            record_confusion_event(connection, source.id, 20, 20_000, "候选", &now).unwrap();
        }
        assert_eq!(
            crate::adaptive::pick_next(3, Some(candidate.id))
                .unwrap()
                .unwrap()
                .selection_reason,
            "difficulty_match"
        );

        let stubborn_path = temp_db("stubborn");
        paths.push(stubborn_path.clone());
        open_db(stubborn_path.to_str().unwrap()).unwrap();
        let stubborn = add_word("stubborn", "顽固").unwrap().unwrap();
        {
            let guard = conn().unwrap();
            require(&guard)
                .unwrap()
                .execute(
                    "UPDATE words SET stubborn_factor=0.8, last_tested=?1 WHERE id=?2",
                    params![crate::sm2::days_later(-8.0), stubborn.id],
                )
                .unwrap();
        }
        assert_eq!(
            crate::adaptive::pick_next(3, None)
                .unwrap()
                .unwrap()
                .selection_reason,
            "stubborn_word"
        );

        let difficulty_path = temp_db("difficulty");
        paths.push(difficulty_path.clone());
        open_db(difficulty_path.to_str().unwrap()).unwrap();
        let matched = add_word("matched", "匹配").unwrap().unwrap();
        {
            let guard = conn().unwrap();
            require(&guard)
                .unwrap()
                .execute(
                    "UPDATE words SET difficulty_level=5 WHERE id=?1",
                    params![matched.id],
                )
                .unwrap();
        }
        assert_eq!(
            crate::adaptive::pick_next(5, None)
                .unwrap()
                .unwrap()
                .selection_reason,
            "difficulty_match"
        );

        let fallback_path = temp_db("fallback");
        paths.push(fallback_path.clone());
        open_db(fallback_path.to_str().unwrap()).unwrap();
        add_word("fallback", "补充").unwrap();
        assert_eq!(
            crate::adaptive::pick_next(10, None)
                .unwrap()
                .unwrap()
                .selection_reason,
            "fallback"
        );

        for path in paths {
            let _ = std::fs::remove_file(path);
        }
    }
}
