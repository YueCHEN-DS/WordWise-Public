use rusqlite::{params, Connection};

use crate::error::VResult;
use crate::models::Sm2State;

const MIN_EF: f64 = 1.3;
const MAX_EF: f64 = 3.2;
const FIRST_INTERVAL: f64 = 1.0;
const SECOND_INTERVAL: f64 = 6.0;
const MAX_INTERVAL: f64 = 180.0;
const DECAY: f64 = 0.85;
const MASTERY_WINDOW: i64 = 10;
const MAX_OVERDUE_PENALTY: f64 = 0.4;
const CONFIDENCE_REWARD: f64 = 0.15;

pub fn sm2_step(quality: u8, ef: f64, interval: f64, reps: u32, actual_days: f64) -> Sm2State {
    let quality = quality.min(5);
    let q = quality as f64;
    let mut next_ef = ef + 0.1 - (5.0 - q) * (0.08 + (5.0 - q) * 0.02);

    if actual_days >= 0.0 && interval > 0.0 {
        next_ef -= overdue_penalty(actual_days, interval);
        if actual_days > interval && quality >= 4 {
            next_ef += confidence_bonus(actual_days, interval);
        }
    }
    next_ef = next_ef.clamp(MIN_EF, MAX_EF);

    if quality < 3 {
        return Sm2State {
            interval: FIRST_INTERVAL,
            ef: next_ef,
            reps: 0,
        };
    }

    let next_reps = reps.saturating_add(1);
    let next_interval = match next_reps {
        1 => FIRST_INTERVAL,
        2 => SECOND_INTERVAL,
        _ => (interval * next_ef).clamp(FIRST_INTERVAL, MAX_INTERVAL),
    };
    Sm2State {
        interval: next_interval,
        ef: next_ef,
        reps: next_reps,
    }
}

fn overdue_penalty(actual_days: f64, expected_days: f64) -> f64 {
    if actual_days <= expected_days || expected_days <= 0.0 {
        return 0.0;
    }
    let ratio = (actual_days - expected_days) / expected_days;
    ((1.0 + ratio).ln() * 0.12).min(MAX_OVERDUE_PENALTY)
}

fn confidence_bonus(actual_days: f64, expected_days: f64) -> f64 {
    if actual_days <= expected_days || expected_days <= 0.0 {
        return 0.0;
    }
    let ratio = actual_days / expected_days;
    (CONFIDENCE_REWARD * (-0.3 * (ratio - 1.0)).exp()).min(CONFIDENCE_REWARD)
}

pub fn response_time_factor(ms: i64) -> f64 {
    if ms <= 0 {
        return 1.0;
    }
    let seconds = ms as f64 / 1000.0;
    let sigmoid = 1.0 / (1.0 + (0.15 * (seconds - 10.0)).exp());
    (0.7 + 0.5 * sigmoid).clamp(0.7, 1.2)
}

pub fn score2q(score: i64) -> u8 {
    match score {
        95..=i64::MAX => 5,
        80..=94 => 4,
        60..=79 => 3,
        40..=59 => 2,
        20..=39 => 1,
        _ => 0,
    }
}

pub fn mastery(conn: &Connection, word_id: i64) -> VResult<f64> {
    let mut stmt = conn.prepare(
        "SELECT score, response_time_ms FROM word_scores
         WHERE word_id = ?1 ORDER BY timestamp DESC, id DESC LIMIT ?2",
    )?;
    let records: Vec<(i64, i64)> = stmt
        .query_map(params![word_id, MASTERY_WINDOW], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })?
        .collect::<Result<_, _>>()?;

    if records.is_empty() {
        return Ok(0.0);
    }

    let mut weighted_scores = 0.0;
    let mut total_weight = 0.0;
    for (index, (score, response_time_ms)) in records.iter().enumerate() {
        let recency = DECAY.powi(index as i32);
        let speed = response_time_factor(*response_time_ms);
        let weight = recency * speed;
        weighted_scores += *score as f64 * weight;
        total_weight += weight;
    }
    Ok(weighted_scores / total_weight)
}

pub fn streak_delta(recent: &[i64]) -> i64 {
    if recent.len() < 3 {
        return 0;
    }
    let last_three = &recent[..3];
    if last_three.iter().all(|score| *score >= 85) {
        1
    } else if last_three.iter().all(|score| *score <= 59) {
        -1
    } else {
        0
    }
}

pub fn is_stubborn(forget_count: i64, total_attempts: i64) -> bool {
    total_attempts >= 4 && forget_count as f64 / total_attempts as f64 >= 0.6
}

pub fn calc_stubborn_factor(forget_count: i64, total_attempts: i64) -> f64 {
    if total_attempts <= 0 {
        return 0.0;
    }
    let ratio = forget_count as f64 / total_attempts as f64;
    let scaled = ((ratio - 0.3) / 0.5).clamp(0.0, 1.0);
    scaled * scaled * (3.0 - 2.0 * scaled)
}

pub fn now_iso() -> String {
    chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string()
}

pub fn days_later(days: f64) -> String {
    let seconds = (days * 86_400.0).round() as i64;
    let future = chrono::Utc::now() + chrono::Duration::seconds(seconds);
    future.format("%Y-%m-%dT%H:%M:%SZ").to_string()
}

pub fn days_between(earlier: &str, later: &str) -> f64 {
    let Some(earlier) = parse_iso(earlier) else {
        return -1.0;
    };
    let Some(later) = parse_iso(later) else {
        return -1.0;
    };
    let seconds = later.signed_duration_since(earlier).num_seconds();
    if seconds < 0 {
        -1.0
    } else {
        seconds as f64 / 86_400.0
    }
}

fn parse_iso(value: &str) -> Option<chrono::DateTime<chrono::Utc>> {
    chrono::DateTime::parse_from_rfc3339(value)
        .map(|date| date.with_timezone(&chrono::Utc))
        .ok()
        .or_else(|| {
            chrono::NaiveDateTime::parse_from_str(value, "%Y-%m-%dT%H:%M:%SZ")
                .ok()
                .map(|date| date.and_utc())
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn failed_recall_resets_repetitions() {
        let state = sm2_step(2, 2.5, 12.0, 4, 12.0);
        assert_eq!(state.reps, 0);
        assert_eq!(state.interval, FIRST_INTERVAL);
    }

    #[test]
    fn intervals_and_easiness_stay_bounded() {
        let state = sm2_step(5, 9.0, 170.0, 8, 170.0);
        assert_eq!(state.ef, MAX_EF);
        assert_eq!(state.interval, MAX_INTERVAL);
    }

    #[test]
    fn invalid_time_order_is_not_treated_as_elapsed_time() {
        assert_eq!(
            days_between("2026-08-02T00:00:00Z", "2026-08-01T00:00:00Z"),
            -1.0
        );
    }
}
