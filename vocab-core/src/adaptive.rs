use rusqlite::params;

use crate::database::{
    avg_response_time, confusion_candidate_ids, conn, mark_confusion_practiced, recent_scores,
    record_confusion_event, require, require_mut, update_forget_stats,
};
use crate::error::{VResult, VocabErr};
use crate::mistakes::{
    mark_review_correct, mark_review_wrong, review_cooldown_at, upsert_wrong,
    validate_review_target,
};
use crate::models::{DbOutcome, PickResult, ProgressRow, ScoreFeedback, WordProfile};
use crate::sm2::{
    calc_stubborn_factor, days_between, days_later, is_stubborn, mastery, now_iso, score2q,
    sm2_step, streak_delta,
};

pub fn record_score(
    word_id: i64,
    score: i64,
    response_time_ms: i64,
    user_answer: &str,
    attempt_source: &str,
    mistake_id: Option<i64>,
) -> VResult<ScoreFeedback> {
    if !matches!(attempt_source, "practice" | "mistake_review") {
        return Err(VocabErr::InvalidInput(format!(
            "unknown attempt source: {attempt_source}"
        )));
    }
    if attempt_source == "mistake_review" && mistake_id.is_none() {
        return Err(VocabErr::InvalidInput(
            "mistake review requires mistakeId".into(),
        ));
    }
    let score = score.clamp(0, 100);
    let now = now_iso();
    let mut guard = conn()?;
    let connection = require_mut(&mut guard)?;
    let tx = connection.transaction()?;

    let review_target = if attempt_source == "mistake_review" {
        Some(validate_review_target(&tx, mistake_id.unwrap(), word_id)?)
    } else {
        None
    };

    tx.execute(
        "INSERT INTO word_scores (
            word_id, score, timestamp, response_time_ms, user_answer, attempt_source
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            word_id,
            score,
            now,
            response_time_ms.max(0),
            user_answer,
            attempt_source
        ],
    )?;

    let (interval, easiness, repetitions, last_tested): (f64, f64, i64, Option<String>) = tx
        .query_row(
            "SELECT sm2_interval, sm2_easiness, sm2_repetitions, last_tested
             FROM words WHERE id = ?1",
            params![word_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )?;

    let actual_days = last_tested
        .as_deref()
        .map(|value| days_between(value, &now))
        .unwrap_or(-1.0);
    let step = sm2_step(
        score2q(score),
        easiness,
        interval,
        repetitions.clamp(0, u32::MAX as i64) as u32,
        actual_days,
    );

    let stubborn_factor: f64 = tx.query_row(
        "SELECT stubborn_factor FROM words WHERE id = ?1",
        params![word_id],
        |row| row.get(0),
    )?;
    let adjusted_interval = if stubborn_factor > 0.1 {
        (step.interval * (1.0 - stubborn_factor * 0.3)).max(1.0)
    } else {
        step.interval
    };
    let next_review = days_later(adjusted_interval);

    tx.execute(
        "UPDATE words
         SET sm2_interval = ?1, sm2_easiness = ?2, sm2_repetitions = ?3,
             sm2_next_review = ?4, last_tested = ?5
         WHERE id = ?6",
        params![
            adjusted_interval,
            step.ef,
            step.reps as i64,
            next_review,
            now,
            word_id
        ],
    )?;

    let counter = if score >= 60 {
        "correct_count"
    } else {
        "incorrect_count"
    };
    tx.execute(
        &format!("UPDATE words SET {counter} = {counter} + 1 WHERE id = ?1"),
        params![word_id],
    )?;
    update_forget_stats(&tx, word_id, score)?;

    let confusion_update =
        record_confusion_event(&tx, word_id, score, response_time_ms, user_answer, &now)?;

    let mut stored_mistake_id = None;
    let mut mistake_resolved = false;
    if score < 60 {
        let next_review_at = if attempt_source == "mistake_review" {
            review_cooldown_at(&now)
        } else {
            now.clone()
        };
        stored_mistake_id = upsert_wrong(
            &tx,
            word_id,
            score,
            response_time_ms,
            user_answer,
            &now,
            &next_review_at,
        )?;
        if let Some(target) = review_target.as_ref() {
            mark_review_wrong(&tx, target.id, score, &now, &next_review_at)?;
        }
    } else if let Some(target) = review_target.as_ref() {
        mark_review_correct(&tx, target.id, score, &now)?;
        mistake_resolved = true;
    }
    let confusion_hint = confusion_update
        .as_ref()
        .filter(|update| update.is_visible)
        .map(|update| match &update.candidate_term {
            Some(term) => format!(
                "检测到重复误答：你可能把这个词与「{term}」的释义混淆了。可在「个人易混图」查看原因。"
            ),
            None => "检测到重复误答：已记录到「个人易混图」，可查看你的错误释义和风险说明。".to_string(),
        })
        .unwrap_or_default();

    let mastery_score = mastery(&tx, word_id)?;
    let difficulty_delta = streak_delta(&recent_scores(&tx, word_id, 3)?);
    let (forget_count, attempts): (i64, i64) = tx.query_row(
        "SELECT forget_count, correct_count + incorrect_count FROM words WHERE id = ?1",
        params![word_id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;

    let feedback = ScoreFeedback {
        success: true,
        mastery_score,
        difficulty_delta,
        sm2_interval: adjusted_interval,
        sm2_next_review: next_review,
        is_stubborn: is_stubborn(forget_count, attempts),
        confusion_hint,
        confusion_update,
        reward_eligible: attempt_source == "practice",
        mistake_id: stored_mistake_id,
        reviewed_mistake_id: review_target.as_ref().map(|target| target.id),
        mistake_resolved,
    };
    tx.commit()?;
    Ok(feedback)
}

pub fn mastery_score(word_id: i64) -> VResult<f64> {
    let guard = conn()?;
    mastery(require(&guard)?, word_id)
}

pub fn pick_next(
    current_difficulty: i64,
    exclude_word_id: Option<i64>,
) -> VResult<Option<PickResult>> {
    let guard = conn()?;
    let connection = require(&guard)?;
    let now = now_iso();
    let excluded = exclude_word_id.unwrap_or(-1);
    let current_difficulty = current_difficulty.clamp(1, 10);

    if let Some(word) = pick_with_query(
        connection,
        "SELECT id, term, meaning, correct_count, incorrect_count, last_tested, difficulty_level
         FROM words
         WHERE sm2_next_review IS NOT NULL AND sm2_next_review <= ?1
           AND sm2_repetitions > 0 AND id != ?2
         ORDER BY sm2_next_review ASC LIMIT 1",
        params![now, excluded],
        true,
        "due_review",
    )? {
        return Ok(Some(word));
    }

    for word_id in confusion_candidate_ids(connection, excluded, &now)? {
        if let Some(word) = pick_with_query(
            connection,
            "SELECT id, term, meaning, correct_count, incorrect_count, last_tested, difficulty_level
             FROM words WHERE id = ?1",
            params![word_id],
            false,
            "confusion_risk",
        )? {
            mark_confusion_practiced(connection, word.id, &now)?;
            return Ok(Some(word));
        }
    }

    let stubborn_cutoff = days_later(-7.0);
    if let Some(word) = pick_with_query(
        connection,
        "SELECT id, term, meaning, correct_count, incorrect_count, last_tested, difficulty_level
         FROM words
         WHERE stubborn_factor > 0.5 AND id != ?1
           AND (last_tested IS NULL OR last_tested < ?2)
         ORDER BY stubborn_factor DESC, RANDOM() LIMIT 1",
        params![excluded, stubborn_cutoff],
        false,
        "stubborn_word",
    )? {
        return Ok(Some(word));
    }

    let lower = (current_difficulty - 2).max(1);
    let upper = (current_difficulty + 2).min(10);
    if let Some(word) = pick_with_query(
        connection,
        "SELECT id, term, meaning, correct_count, incorrect_count, last_tested, difficulty_level
         FROM words
         WHERE difficulty_level BETWEEN ?1 AND ?2 AND id != ?3
         ORDER BY forget_count DESC, last_tested ASC NULLS FIRST, RANDOM() LIMIT 1",
        params![lower, upper, excluded],
        false,
        "difficulty_match",
    )? {
        return Ok(Some(word));
    }

    pick_with_query(
        connection,
        "SELECT id, term, meaning, correct_count, incorrect_count, last_tested, difficulty_level
         FROM words WHERE id != ?1 ORDER BY RANDOM() LIMIT 1",
        params![excluded],
        false,
        "fallback",
    )
}

fn pick_with_query<P: rusqlite::Params>(
    connection: &rusqlite::Connection,
    sql: &str,
    params: P,
    is_review: bool,
    selection_reason: &str,
) -> VResult<Option<PickResult>> {
    let mut statement = connection.prepare(sql)?;
    let result = statement.query_row(params, |row| {
        Ok(PickResult {
            id: row.get(0)?,
            term: row.get(1)?,
            meaning: row.get(2)?,
            correct_count: row.get(3)?,
            incorrect_count: row.get(4)?,
            last_tested: row.get(5)?,
            difficulty_level: row.get(6)?,
            mastery_score: 0.0,
            is_review,
            stubborn_factor: 0.0,
            avg_response_time: 0,
            selection_reason: selection_reason.to_string(),
        })
    });
    match result {
        Ok(mut word) => {
            enrich_pick_result(connection, &mut word)?;
            Ok(Some(word))
        }
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(error) => Err(error.into()),
    }
}

fn enrich_pick_result(connection: &rusqlite::Connection, word: &mut PickResult) -> VResult<()> {
    word.mastery_score = mastery(connection, word.id)?;
    word.stubborn_factor = connection.query_row(
        "SELECT stubborn_factor FROM words WHERE id = ?1",
        params![word.id],
        |row| row.get(0),
    )?;
    word.avg_response_time = avg_response_time(connection, word.id)?;
    Ok(())
}

pub fn calc_word_profile(word_id: i64) -> VResult<WordProfile> {
    let guard = conn()?;
    let connection = require(&guard)?;
    let (term, base_difficulty, forget_count, correct_count, incorrect_count): (
        String,
        i64,
        i64,
        i64,
        i64,
    ) = connection
        .query_row(
            "SELECT term, difficulty_level, forget_count, correct_count, incorrect_count
             FROM words WHERE id = ?1",
            params![word_id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            },
        )
        .map_err(|error| VocabErr::ProfileCalcFailed(format!("word_id={word_id}: {error}")))?;

    let attempts = correct_count + incorrect_count;
    let forget_ratio = if attempts > 0 {
        forget_count as f64 / attempts as f64
    } else {
        0.0
    };
    let average_response_time = avg_response_time(connection, word_id)?;
    let speed_component = if average_response_time > 0 {
        ((average_response_time as f64 / 1000.0 - 15.0) / 10.0)
            .tanh()
            .mul_add(0.5, 0.5)
            .clamp(0.0, 1.0)
    } else {
        0.5
    };
    let composite_score =
        (0.4 * base_difficulty as f64 + 0.3 * forget_ratio * 10.0 + 0.3 * speed_component * 10.0)
            .clamp(1.0, 10.0);

    Ok(WordProfile {
        word_id,
        term,
        base_difficulty,
        forget_ratio,
        stubborn_factor: calc_stubborn_factor(forget_count, attempts),
        avg_response_ms: average_response_time,
        last_score: recent_scores(connection, word_id, 1)?
            .first()
            .copied()
            .unwrap_or(0),
        composite_score,
    })
}

pub fn progress_summary() -> VResult<Vec<ProgressRow>> {
    let guard = conn()?;
    let connection = require(&guard)?;
    let mut statement = connection.prepare(
        "SELECT DISTINCT words.id, words.term, words.difficulty_level, words.sm2_next_review
         FROM words INNER JOIN word_scores ON word_scores.word_id = words.id
         ORDER BY words.term LIMIT 200",
    )?;
    let rows: Vec<(i64, String, i64, Option<String>)> = statement
        .query_map([], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
        })?
        .collect::<Result<_, _>>()?;

    let mut progress = Vec::with_capacity(rows.len());
    for (word_id, term, difficulty_level, sm2_next_review) in rows {
        progress.push(ProgressRow {
            word_id,
            term,
            mastery_score: mastery(connection, word_id)?,
            difficulty_level,
            sm2_next_review,
            recent_scores: recent_scores(connection, word_id, 5)?,
        });
    }
    Ok(progress)
}

pub fn set_difficulty(word_id: i64, level: i64) -> VResult<DbOutcome> {
    let mut guard = conn()?;
    require_mut(&mut guard)?.execute(
        "UPDATE words SET difficulty_level = ?1 WHERE id = ?2",
        params![level.clamp(1, 10), word_id],
    )?;
    Ok(DbOutcome {
        success: true,
        message: format!("difficulty={}", level.clamp(1, 10)),
    })
}

pub fn bulk_set_difficulty(level: i64) -> VResult<DbOutcome> {
    let level = level.clamp(1, 10);
    let mut guard = conn()?;
    let changed = require_mut(&mut guard)?.execute(
        "UPDATE words SET difficulty_level = ?1 WHERE difficulty_level = 1",
        params![level],
    )?;
    Ok(DbOutcome {
        success: true,
        message: format!("{changed} words -> diff {level}"),
    })
}
