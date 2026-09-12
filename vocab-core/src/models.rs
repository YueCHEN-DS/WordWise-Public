use napi_derive::napi;

#[napi(object)]
#[derive(Debug, Clone)]
pub struct WordEntry {
    pub id: i64,
    pub term: String,
    pub meaning: String,
    pub correct_count: i64,
    pub incorrect_count: i64,
    pub last_tested: Option<String>,
}

#[napi(object)]
#[derive(Debug, Clone)]
pub struct ImportStats {
    pub imported: i64,
    pub skipped: i64,
    pub total: i64,
}

#[napi(object)]
#[derive(Debug, Clone)]
pub struct DbOutcome {
    pub success: bool,
    pub message: String,
}

#[napi(object)]
#[derive(Debug, Clone)]
pub struct PickResult {
    pub id: i64,
    pub term: String,
    pub meaning: String,
    pub correct_count: i64,
    pub incorrect_count: i64,
    pub last_tested: Option<String>,
    pub difficulty_level: i64,
    pub mastery_score: f64,
    pub is_review: bool,
    pub stubborn_factor: f64,
    pub avg_response_time: i64,
    pub selection_reason: String,
}

#[napi(object)]
#[derive(Debug, Clone)]
pub struct ProgressRow {
    pub word_id: i64,
    pub term: String,
    pub mastery_score: f64,
    pub difficulty_level: i64,
    pub sm2_next_review: Option<String>,
    pub recent_scores: Vec<i64>,
}

#[napi(object)]
#[derive(Debug, Clone)]
pub struct ConfusionUpdate {
    pub answer_fingerprint: String,
    pub occurrence_count: i64,
    pub risk_score: f64,
    pub is_visible: bool,
    pub candidate_word_id: Option<i64>,
    pub candidate_term: Option<String>,
    pub candidate_confidence: f64,
}

#[napi(object)]
#[derive(Debug, Clone)]
pub struct ConfusionSignal {
    pub answer_fingerprint: String,
    pub occurrence_count: i64,
    pub risk_score: f64,
    pub candidate_word_id: Option<i64>,
    pub candidate_term: Option<String>,
    pub candidate_confidence: f64,
    pub is_confirmed: bool,
}

#[napi(object)]
#[derive(Debug, Clone)]
pub struct AnswerCandidate {
    pub word_id: i64,
    pub term: String,
    pub meaning: String,
    pub confidence: f64,
}

#[napi(object)]
#[derive(Debug, Clone)]
pub struct ConfusionEdge {
    pub source_word_id: i64,
    pub source_term: String,
    pub source_meaning: String,
    pub answer_text: String,
    pub answer_fingerprint: String,
    pub candidate_word_id: Option<i64>,
    pub candidate_term: Option<String>,
    pub candidate_meaning: Option<String>,
    pub candidate_confidence: f64,
    pub occurrence_count: i64,
    pub risk_score: f64,
    pub average_score: f64,
    pub average_response_time_ms: i64,
    pub last_seen: String,
    pub is_confirmed: bool,
}

#[napi(object)]
#[derive(Debug, Clone)]
pub struct ScoreFeedback {
    pub success: bool,
    pub mastery_score: f64,
    pub difficulty_delta: i64,
    pub sm2_interval: f64,
    pub sm2_next_review: String,
    pub is_stubborn: bool,
    pub confusion_hint: String,
    pub confusion_update: Option<ConfusionUpdate>,
    pub reward_eligible: bool,
    pub mistake_id: Option<i64>,
    pub reviewed_mistake_id: Option<i64>,
    pub mistake_resolved: bool,
}

#[napi(object)]
#[derive(Debug, Clone)]
pub struct MistakeQueueStatus {
    pub due_count: i64,
    pub unresolved_count: i64,
    pub next_eligible_at: Option<String>,
}

#[napi(object)]
#[derive(Debug, Clone)]
pub struct MistakeItem {
    pub mistake_id: i64,
    pub word_id: i64,
    pub term: String,
    pub meaning: String,
    pub answer_text: String,
    pub wrong_count: i64,
    pub minimum_score: i64,
    pub last_wrong_score: i64,
    pub priority_score: f64,
    pub first_wrong_at: String,
    pub last_wrong_at: String,
    pub next_review_at: String,
    pub review_count: i64,
    pub resolved_at: Option<String>,
}

#[napi(object)]
#[derive(Debug, Clone)]
pub struct WordProfile {
    pub word_id: i64,
    pub term: String,
    pub base_difficulty: i64,
    pub forget_ratio: f64,
    pub stubborn_factor: f64,
    pub avg_response_ms: i64,
    pub last_score: i64,
    pub composite_score: f64, // 综合难度 1.0~10.0
}

#[derive(Debug, Clone, Copy)]
pub struct Sm2State {
    pub interval: f64,
    pub ef: f64,
    pub reps: u32,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum PracticeMode {
    Sequential,
    Hard,
    Random,
}

impl PracticeMode {
    pub fn parse(value: &str) -> Self {
        match value {
            "sequential" => Self::Sequential,
            "hard" => Self::Hard,
            _ => Self::Random,
        }
    }
}
