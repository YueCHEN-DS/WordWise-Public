use std::collections::BTreeMap;

use chrono::{Duration, Utc};
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use unicode_normalization::UnicodeNormalization;

use crate::error::{VResult, VocabErr};
use crate::models::{MistakeItem, MistakeQueueStatus};

pub const CURRENT_FINGERPRINT_VERSION: i64 = 1;
const POS_PREFIXES: [&str; 9] = [
    "adj.", "adv.", "prep.", "conj.", "art.", "vt.", "vi.", "n.", "v.",
];
const EXTRA_PUNCTUATION: [char; 16] = [
    '，', '。', '；', '、', '：', '！', '？', '（', '）', '【', '】', '《', '》', '“', '”', '‘',
];

pub fn fingerprint_v1(raw: &str) -> String {
    let normalized: String = raw.nfkc().collect::<String>().trim().to_lowercase();
    let mut value = normalized.as_str();
    for _ in 0..4 {
        let trimmed = value.trim_start_matches(char::is_whitespace);
        let Some(prefix) = POS_PREFIXES
            .iter()
            .find(|prefix| trimmed.starts_with(**prefix))
        else {
            value = trimmed;
            break;
        };
        value = &trimmed[prefix.len()..];
    }

    value
        .chars()
        .filter(|ch| {
            !ch.is_whitespace()
                && !ch.is_ascii_punctuation()
                && !EXTRA_PUNCTUATION.contains(ch)
                && *ch != '’'
        })
        .collect()
}

pub fn display_answer(raw: &str) -> String {
    raw.trim().chars().take(200).collect()
}

pub fn priority_score(
    wrong_count: i64,
    total_wrong_score: i64,
    total_response_time_ms: i64,
) -> f64 {
    if wrong_count <= 0 {
        return 0.0;
    }
    let average_score = total_wrong_score as f64 / wrong_count as f64;
    let average_response = total_response_time_ms as f64 / wrong_count as f64;
    let severity = 1.0 - average_score.clamp(0.0, 59.0) / 60.0;
    let repetition = (wrong_count as f64 / 5.0).min(1.0);
    let hesitation = (average_response / 30_000.0).clamp(0.0, 1.0);
    (100.0 * (0.50 * severity + 0.35 * repetition + 0.15 * hesitation) * 100.0).round() / 100.0
}

pub fn review_cooldown_at(now: &str) -> String {
    chrono::DateTime::parse_from_rfc3339(now)
        .map(|value| (value + Duration::minutes(15)).to_rfc3339())
        .unwrap_or_else(|_| (Utc::now() + Duration::minutes(15)).to_rfc3339())
}

#[derive(Debug)]
pub struct ReviewTarget {
    pub id: i64,
}

pub fn validate_review_target(
    tx: &Transaction<'_>,
    mistake_id: i64,
    word_id: i64,
) -> VResult<ReviewTarget> {
    let target = tx
        .query_row(
            "SELECT id FROM mistake_items
             WHERE id = ?1 AND word_id = ?2 AND fingerprint_version = ?3
               AND resolved_at IS NULL AND superseded_at IS NULL",
            params![mistake_id, word_id, CURRENT_FINGERPRINT_VERSION],
            |row| Ok(ReviewTarget { id: row.get(0)? }),
        )
        .optional()?;
    target.ok_or_else(|| {
        VocabErr::InvalidInput(format!(
            "invalid current mistake item {mistake_id} for word {word_id}"
        ))
    })
}

pub fn upsert_wrong(
    tx: &Transaction<'_>,
    word_id: i64,
    score: i64,
    response_time_ms: i64,
    raw_answer: &str,
    now: &str,
    next_review_at: &str,
) -> VResult<Option<i64>> {
    let fingerprint = fingerprint_v1(raw_answer);
    if fingerprint.is_empty() {
        return Ok(None);
    }
    let score = score.clamp(0, 59);
    let answer = display_answer(raw_answer);
    tx.execute(
        "INSERT INTO mistake_items (
            word_id, fingerprint, fingerprint_version, answer_text,
            wrong_count, total_wrong_score, minimum_score, last_wrong_score,
            total_response_time_ms, first_wrong_at, last_wrong_at, next_review_at,
            priority_score, review_count, resolved_at, superseded_at
         ) VALUES (?1, ?2, ?3, ?4, 1, ?5, ?5, ?5, ?6, ?7, ?7, ?8, 0, 0, NULL, NULL)
         ON CONFLICT(word_id, fingerprint_version, fingerprint) DO UPDATE SET
            answer_text = excluded.answer_text,
            wrong_count = mistake_items.wrong_count + 1,
            total_wrong_score = mistake_items.total_wrong_score + excluded.total_wrong_score,
            minimum_score = MIN(mistake_items.minimum_score, excluded.minimum_score),
            last_wrong_score = excluded.last_wrong_score,
            total_response_time_ms = mistake_items.total_response_time_ms + excluded.total_response_time_ms,
            last_wrong_at = excluded.last_wrong_at,
            next_review_at = excluded.next_review_at,
            resolved_at = NULL
         WHERE mistake_items.superseded_at IS NULL",
        params![
            word_id,
            fingerprint,
            CURRENT_FINGERPRINT_VERSION,
            answer,
            score,
            response_time_ms.max(0),
            now,
            next_review_at,
        ],
    )?;

    let row: (i64, i64, i64, i64) = tx.query_row(
        "SELECT id, wrong_count, total_wrong_score, total_response_time_ms
         FROM mistake_items
         WHERE word_id = ?1 AND fingerprint_version = ?2 AND fingerprint = ?3
           AND superseded_at IS NULL",
        params![word_id, CURRENT_FINGERPRINT_VERSION, fingerprint],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
    )?;
    let priority = priority_score(row.1, row.2, row.3);
    tx.execute(
        "UPDATE mistake_items SET priority_score = ?1 WHERE id = ?2",
        params![priority, row.0],
    )?;
    Ok(Some(row.0))
}

pub fn mark_review_wrong(
    tx: &Transaction<'_>,
    mistake_id: i64,
    score: i64,
    now: &str,
    next_review_at: &str,
) -> VResult<()> {
    let changed = tx.execute(
        "UPDATE mistake_items
         SET review_count = review_count + 1, last_reviewed_at = ?1,
             last_review_score = ?2, next_review_at = ?3, resolved_at = NULL
         WHERE id = ?4 AND fingerprint_version = ?5 AND superseded_at IS NULL",
        params![
            now,
            score.clamp(0, 59),
            next_review_at,
            mistake_id,
            CURRENT_FINGERPRINT_VERSION
        ],
    )?;
    if changed != 1 {
        return Err(VocabErr::InvalidInput(
            "mistake review target changed".into(),
        ));
    }
    Ok(())
}

pub fn mark_review_correct(
    tx: &Transaction<'_>,
    mistake_id: i64,
    score: i64,
    now: &str,
) -> VResult<()> {
    let changed = tx.execute(
        "UPDATE mistake_items
         SET review_count = review_count + 1, last_reviewed_at = ?1,
             last_review_score = ?2, resolved_at = ?1
         WHERE id = ?3 AND fingerprint_version = ?4 AND superseded_at IS NULL",
        params![
            now,
            score.clamp(60, 100),
            mistake_id,
            CURRENT_FINGERPRINT_VERSION
        ],
    )?;
    if changed != 1 {
        return Err(VocabErr::InvalidInput(
            "mistake review target changed".into(),
        ));
    }
    Ok(())
}

#[derive(Debug)]
struct Aggregate {
    word_id: i64,
    fingerprint: String,
    answer_text: String,
    wrong_count: i64,
    total_wrong_score: i64,
    minimum_score: i64,
    last_wrong_score: i64,
    total_response_time_ms: i64,
    first_wrong_at: String,
    last_wrong_at: String,
}

pub fn backfill_v1(tx: &Transaction<'_>, migration_time: &str) -> VResult<()> {
    let mut statement = tx.prepare(
        "SELECT word_id, score, timestamp, response_time_ms, user_answer
         FROM word_scores
         WHERE score < 60 AND TRIM(user_answer) != ''
         ORDER BY timestamp ASC, id ASC",
    )?;
    let rows = statement.query_map([], |row| {
        Ok((
            row.get::<_, i64>(0)?,
            row.get::<_, i64>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, i64>(3)?,
            row.get::<_, String>(4)?,
        ))
    })?;
    let mut groups: BTreeMap<(i64, String), Aggregate> = BTreeMap::new();
    for row in rows {
        let (word_id, score, timestamp, response_time_ms, answer) = row?;
        let fingerprint = fingerprint_v1(&answer);
        if fingerprint.is_empty() {
            continue;
        }
        let score = score.clamp(0, 59);
        let key = (word_id, fingerprint.clone());
        let entry = groups.entry(key).or_insert_with(|| Aggregate {
            word_id,
            fingerprint,
            answer_text: display_answer(&answer),
            wrong_count: 0,
            total_wrong_score: 0,
            minimum_score: score,
            last_wrong_score: score,
            total_response_time_ms: 0,
            first_wrong_at: timestamp.clone(),
            last_wrong_at: timestamp.clone(),
        });
        entry.wrong_count += 1;
        entry.total_wrong_score += score;
        entry.minimum_score = entry.minimum_score.min(score);
        entry.last_wrong_score = score;
        entry.total_response_time_ms += response_time_ms.max(0);
        entry.answer_text = display_answer(&answer);
        entry.last_wrong_at = timestamp;
    }
    drop(statement);

    for aggregate in groups.into_values() {
        let priority = priority_score(
            aggregate.wrong_count,
            aggregate.total_wrong_score,
            aggregate.total_response_time_ms,
        );
        tx.execute(
            "INSERT INTO mistake_items (
                word_id, fingerprint, fingerprint_version, answer_text, wrong_count,
                total_wrong_score, minimum_score, last_wrong_score, total_response_time_ms,
                first_wrong_at, last_wrong_at, next_review_at, priority_score, review_count,
                last_reviewed_at, last_review_score, resolved_at, superseded_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, 0,
                       NULL, NULL, NULL, NULL)",
            params![
                aggregate.word_id,
                aggregate.fingerprint,
                CURRENT_FINGERPRINT_VERSION,
                aggregate.answer_text,
                aggregate.wrong_count,
                aggregate.total_wrong_score,
                aggregate.minimum_score,
                aggregate.last_wrong_score,
                aggregate.total_response_time_ms,
                aggregate.first_wrong_at,
                aggregate.last_wrong_at,
                migration_time,
                priority,
            ],
        )?;
    }
    Ok(())
}

pub fn queue_status(connection: &Connection, now: &str) -> VResult<MistakeQueueStatus> {
    let (due_count, unresolved_count, next_eligible_at) = connection.query_row(
        "SELECT
            SUM(CASE WHEN next_review_at <= ?1 THEN 1 ELSE 0 END),
            COUNT(*),
            MIN(CASE WHEN next_review_at > ?1 THEN next_review_at END)
         FROM mistake_items
         WHERE fingerprint_version = ?2 AND resolved_at IS NULL AND superseded_at IS NULL",
        params![now, CURRENT_FINGERPRINT_VERSION],
        |row| {
            Ok((
                row.get::<_, Option<i64>>(0)?.unwrap_or(0),
                row.get(1)?,
                row.get(2)?,
            ))
        },
    )?;
    Ok(MistakeQueueStatus {
        due_count,
        unresolved_count,
        next_eligible_at,
    })
}

fn mistake_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<MistakeItem> {
    Ok(MistakeItem {
        mistake_id: row.get(0)?,
        word_id: row.get(1)?,
        term: row.get(2)?,
        meaning: row.get(3)?,
        answer_text: row.get(4)?,
        wrong_count: row.get(5)?,
        minimum_score: row.get(6)?,
        last_wrong_score: row.get(7)?,
        priority_score: row.get(8)?,
        first_wrong_at: row.get(9)?,
        last_wrong_at: row.get(10)?,
        next_review_at: row.get(11)?,
        review_count: row.get(12)?,
        resolved_at: row.get(13)?,
    })
}

pub fn next_mistake(
    connection: &Connection,
    excluded_id: Option<i64>,
    now: &str,
) -> VResult<Option<MistakeItem>> {
    connection
        .query_row(
            "SELECT m.id, m.word_id, w.term, w.meaning, m.answer_text, m.wrong_count,
                    m.minimum_score, m.last_wrong_score, m.priority_score,
                    m.first_wrong_at, m.last_wrong_at, m.next_review_at,
                    m.review_count, m.resolved_at
             FROM mistake_items AS m INDEXED BY idx_mistake_due_order
             JOIN words w ON w.id = m.word_id
             WHERE m.fingerprint_version = ?1 AND m.resolved_at IS NULL
               AND m.superseded_at IS NULL AND m.next_review_at <= ?2
               AND m.id != ?3
             ORDER BY m.priority_score DESC, m.last_wrong_at DESC, m.id ASC
             LIMIT 1",
            params![CURRENT_FINGERPRINT_VERSION, now, excluded_id.unwrap_or(-1)],
            mistake_from_row,
        )
        .optional()
        .map_err(Into::into)
}

pub fn summary(
    connection: &Connection,
    status: &str,
    limit: i64,
    cursor: Option<i64>,
    now: &str,
) -> VResult<Vec<MistakeItem>> {
    let status_clause = match status {
        "resolved" => "m.resolved_at IS NOT NULL",
        "waiting" => "m.resolved_at IS NULL AND m.next_review_at > ?2",
        "due" => "m.resolved_at IS NULL AND m.next_review_at <= ?2",
        _ => "m.resolved_at IS NULL",
    };
    let sql = format!(
        "SELECT m.id, m.word_id, w.term, w.meaning, m.answer_text, m.wrong_count,
                m.minimum_score, m.last_wrong_score, m.priority_score,
                m.first_wrong_at, m.last_wrong_at, m.next_review_at,
                m.review_count, m.resolved_at
         FROM mistake_items m JOIN words w ON w.id = m.word_id
         WHERE m.fingerprint_version = ?1 AND m.superseded_at IS NULL
           AND {status_clause}
         ORDER BY m.priority_score DESC, m.last_wrong_at DESC, m.id ASC LIMIT ?4 OFFSET ?3"
    );
    let mut statement = connection.prepare(&sql)?;
    let rows = statement.query_map(
        params![
            CURRENT_FINGERPRINT_VERSION,
            now,
            cursor.unwrap_or(0).max(0),
            limit.clamp(1, 200)
        ],
        mistake_from_row,
    )?;
    Ok(rows.collect::<Result<_, _>>()?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fingerprint_conformance() {
        assert_eq!(fingerprint_v1("Apple"), "apple");
        assert_eq!(fingerprint_v1(" apple "), "apple");
        assert_eq!(fingerprint_v1("vt. vi. Run"), "run");
        assert_eq!(fingerprint_v1("v. 放 弃！"), "放弃");
        assert_eq!(fingerprint_v1("ＡＰＰＬＥ"), "apple");
    }

    #[test]
    fn priority_is_reproducible() {
        assert_eq!(priority_score(1, 0, 0), 57.0);
        assert_eq!(priority_score(5, 295, 150_000), 50.83);
    }
}
