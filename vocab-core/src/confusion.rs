use chrono::{DateTime, NaiveDateTime, Utc};
use std::collections::HashSet;

pub const CANDIDATE_CONFIDENCE: f64 = 0.78;
pub const MIN_VISIBLE_OCCURRENCES: i64 = 2;
pub const MIN_VISIBLE_RISK: f64 = 40.0;
pub const COOLDOWN_MINUTES: i64 = 15; // 刚练过的混淆词 15 分钟内不再出

pub fn normalize_answer(value: &str) -> String {
    let mut text = value.trim().to_lowercase();
    for prefix in [
        "adj.", "adv.", "prep.", "conj.", "art.", "vt.", "vi.", "n.", "v.",
    ] {
        if let Some(rest) = text.strip_prefix(prefix) {
            text = rest.trim_start().to_string();
            break;
        }
    }

    text.chars()
        .filter(|ch| !ch.is_whitespace() && !is_punctuation(*ch))
        .collect()
}

pub fn candidate_similarity(answer: &str, meaning: &str) -> f64 {
    let answer = normalize_answer(answer);
    let meaning = normalize_answer(meaning);
    if answer.chars().count() < 2 || meaning.is_empty() {
        return 0.0;
    }
    if answer == meaning {
        return 1.0;
    }
    if meaning.contains(&answer) {
        return 0.88;
    }
    if answer.contains(&meaning) && meaning.chars().count() >= 2 {
        return 0.82;
    }

    bigram_jaccard(&answer, &meaning)
}

pub fn is_confident_candidate(score: f64) -> bool {
    score >= CANDIDATE_CONFIDENCE
}

pub fn calculate_risk(
    occurrences: i64,
    average_score: f64,
    average_response_time_ms: i64,
    last_seen: &str,
    now: &str,
) -> f64 {
    let repetition = (occurrences as f64 / 3.0).clamp(0.0, 1.0);
    let recency = recency_weight(last_seen, now);
    let incorrectness = (1.0 - average_score.clamp(0.0, 100.0) / 100.0).clamp(0.0, 1.0);
    let hesitation = (average_response_time_ms as f64 / 30_000.0).clamp(0.0, 1.0);

    (0.45 * repetition + 0.30 * recency + 0.15 * incorrectness + 0.10 * hesitation) * 100.0
}

pub fn is_visible(occurrences: i64, risk: f64) -> bool {
    occurrences >= MIN_VISIBLE_OCCURRENCES && risk >= MIN_VISIBLE_RISK
}

pub fn is_in_cooldown(last_seen: &str, now: &str) -> bool {
    let Some(last_seen) = parse_iso(last_seen) else {
        return false;
    };
    let Some(now) = parse_iso(now) else {
        return false;
    };
    let minutes = now.signed_duration_since(last_seen).num_minutes();
    (0..COOLDOWN_MINUTES).contains(&minutes)
}

fn recency_weight(last_seen: &str, now: &str) -> f64 {
    let Some(last_seen) = parse_iso(last_seen) else {
        return 0.5;
    };
    let Some(now) = parse_iso(now) else {
        return 0.5;
    };
    let days = now.signed_duration_since(last_seen).num_seconds().max(0) as f64 / 86_400.0;
    (-days / 14.0).exp().clamp(0.0, 1.0)
}

fn parse_iso(value: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(value)
        .map(|dt| dt.with_timezone(&Utc))
        .ok()
        .or_else(|| {
            NaiveDateTime::parse_from_str(value, "%Y-%m-%dT%H:%M:%SZ")
                .ok()
                .map(|dt| dt.and_utc())
        })
}

fn bigram_jaccard(left: &str, right: &str) -> f64 {
    let left = bigrams(left);
    let right = bigrams(right);
    if left.is_empty() || right.is_empty() {
        return 0.0;
    }
    let intersection = left.intersection(&right).count() as f64;
    let union = left.union(&right).count() as f64;
    intersection / union
}

fn bigrams(value: &str) -> HashSet<(char, char)> {
    value
        .chars()
        .collect::<Vec<_>>()
        .windows(2)
        .map(|pair| (pair[0], pair[1]))
        .collect()
}

fn is_punctuation(ch: char) -> bool {
    ch.is_ascii_punctuation()
        || matches!(
            ch,
            '，' | '。'
                | '、'
                | '；'
                | '：'
                | '！'
                | '？'
                | '（'
                | '）'
                | '【'
                | '】'
                | '《'
                | '》'
                | '“'
                | '”'
                | '‘'
                | '’'
        )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_presentation_noise_without_losing_meaning() {
        assert_eq!(normalize_answer("  v. 放 弃！ "), "放弃");
        assert_eq!(normalize_answer("ADJ.  不 正 常"), "不正常");
        assert_eq!(normalize_answer("VT. “放 纵”"), "放纵");
    }

    #[test]
    fn scores_clear_definition_matches_above_the_gate() {
        let score = candidate_similarity("放弃", "v. 放弃；抛弃");
        assert!(is_confident_candidate(score));
    }

    #[test]
    fn weak_overlap_does_not_create_a_candidate_link() {
        let score = candidate_similarity("放纵", "v. 放弃；抛弃");
        assert!(!is_confident_candidate(score));
    }

    #[test]
    fn repeated_recent_errors_produce_a_visible_risk() {
        let now = "2026-07-31T12:00:00Z";
        let risk = calculate_risk(2, 10.0, 20_000, now, now);
        assert!(risk >= MIN_VISIBLE_RISK);
        assert!(is_visible(2, risk));
    }

    #[test]
    fn cooldown_blocks_immediate_reselection_only() {
        assert!(is_in_cooldown(
            "2026-07-31T11:50:00Z",
            "2026-07-31T12:00:00Z"
        ));
        assert!(!is_in_cooldown(
            "2026-07-31T11:40:00Z",
            "2026-07-31T12:00:00Z"
        ));
    }
}
