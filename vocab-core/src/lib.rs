mod adaptive;
mod confusion;
mod database;
mod error;
mod import;
mod mistakes;
mod models;
mod sm2;

use napi::bindgen_prelude::*;
use napi_derive::napi;

use models::*;

#[napi]
pub fn setup_db(db_path: String) -> Result<DbOutcome> {
    Ok(database::open_db(&db_path)?)
}

#[napi]
pub async fn import_words_from_file(file_path: String) -> Result<ImportStats> {
    let r = tokio::task::spawn_blocking(move || import::import_wordlist(&file_path))
        .await
        .map_err(|e| Error::from_reason(format!("task panic: {e}")))?;
    Ok(r?)
}

#[napi]
pub fn add_word(term: String, meaning: String) -> Result<Option<WordEntry>> {
    Ok(database::add_word(&term, &meaning)?)
}

#[napi]
pub fn delete_word(id: i64) -> Result<DbOutcome> {
    Ok(database::delete_word(id)?)
}

#[napi]
pub fn get_all_words() -> Result<Vec<WordEntry>> {
    Ok(database::all_words()?)
}

#[napi]
pub fn get_word_by_term(term: String) -> Result<Option<WordEntry>> {
    Ok(database::find_word(&term)?)
}

#[napi]
pub fn get_practice_batch(limit: i64, mode: String, offset: i64) -> Result<Vec<WordEntry>> {
    let m = PracticeMode::parse(&mode);
    Ok(database::pick_batch(limit, m, offset)?)
}

#[napi]
pub fn update_word_score(id: i64, is_correct: bool) -> Result<DbOutcome> {
    Ok(database::bump_score(id, is_correct)?)
}

#[napi]
pub fn save_session(words_tested: i64, correct: i64, score: i64) -> Result<DbOutcome> {
    Ok(database::log_session(words_tested, correct, score)?)
}

#[napi]
pub fn get_word_count() -> Result<i64> {
    Ok(database::word_count()?)
}

#[napi]
pub fn export_words_json() -> Result<String> {
    Ok(database::dump_json()?)
}

#[napi]
pub fn record_semantic_score(
    word_id: i64,
    score: i64,
    response_time_ms: i64,
    user_answer: String,
    attempt_source: Option<String>,
    mistake_id: Option<i64>,
) -> Result<ScoreFeedback> {
    let source = attempt_source.unwrap_or_else(|| "practice".to_string());
    Ok(adaptive::record_score(
        word_id,
        score,
        response_time_ms,
        &user_answer,
        &source,
        mistake_id,
    )?)
}

#[napi]
pub fn get_mistake_queue_status() -> Result<MistakeQueueStatus> {
    let guard = database::conn()?;
    Ok(mistakes::queue_status(
        database::require(&guard)?,
        &sm2::now_iso(),
    )?)
}

#[napi]
pub fn get_next_mistake(exclude_mistake_id: Option<i64>) -> Result<Option<MistakeItem>> {
    let guard = database::conn()?;
    Ok(mistakes::next_mistake(
        database::require(&guard)?,
        exclude_mistake_id,
        &sm2::now_iso(),
    )?)
}

#[napi]
pub fn get_mistake_summary(
    status: String,
    limit: i64,
    cursor: Option<i64>,
) -> Result<Vec<MistakeItem>> {
    let guard = database::conn()?;
    Ok(mistakes::summary(
        database::require(&guard)?,
        &status,
        limit,
        cursor,
        &sm2::now_iso(),
    )?)
}

#[napi]
pub fn get_mastery_score(word_id: i64) -> Result<f64> {
    Ok(adaptive::mastery_score(word_id)?)
}

#[napi]
pub fn get_next_adaptive_word(
    current_difficulty: i64,
    exclude_word_id: Option<i64>,
) -> Result<Option<PickResult>> {
    Ok(adaptive::pick_next(current_difficulty, exclude_word_id)?)
}

#[napi]
pub fn get_user_progress_summary() -> Result<Vec<ProgressRow>> {
    Ok(adaptive::progress_summary()?)
}

#[napi]
pub fn update_word_difficulty(word_id: i64, new_level: i64) -> Result<DbOutcome> {
    Ok(adaptive::set_difficulty(word_id, new_level)?)
}

#[napi]
pub fn set_default_difficulty(level: i64) -> Result<DbOutcome> {
    Ok(adaptive::bulk_set_difficulty(level)?)
}

#[napi]
pub fn get_word_profile(word_id: i64) -> Result<WordProfile> {
    Ok(adaptive::calc_word_profile(word_id)?)
}

#[napi]
pub fn get_confusion_map(limit: i64) -> Result<Vec<ConfusionEdge>> {
    Ok(database::confusion_map(limit)?)
}

#[napi]
pub fn get_confusion_detail(
    source_word_id: i64,
    answer_fingerprint: String,
) -> Result<Option<ConfusionEdge>> {
    Ok(database::confusion_detail(
        source_word_id,
        &answer_fingerprint,
    )?)
}

#[napi]
pub fn get_confusion_signal(
    source_word_id: i64,
    user_answer: String,
) -> Result<Option<ConfusionSignal>> {
    Ok(database::confusion_signal(source_word_id, &user_answer)?)
}

#[napi]
pub fn get_answer_candidate(
    source_word_id: i64,
    user_answer: String,
) -> Result<Option<AnswerCandidate>> {
    Ok(database::answer_candidate(source_word_id, &user_answer)?)
}
