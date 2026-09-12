//! 统一错误类型。所有错误都经过 VocabErr 转成 NAPI Error 返给 JS 层。

use napi::Error;

#[derive(Debug)]
pub enum VocabErr {
    Sql(rusqlite::Error),
    Io(std::io::Error),
    Json(serde_json::Error),
    LockPoisoned,
    NotInit,
    Import(String),
    InvalidInput(String),
    ProfileCalcFailed(String),
}

impl From<VocabErr> for Error {
    fn from(e: VocabErr) -> Self {
        let msg = match e {
            VocabErr::Sql(e) => format!("sqlite: {e}"),
            VocabErr::Io(e) => format!("io: {e}"),
            VocabErr::Json(e) => format!("json: {e}"),
            VocabErr::LockPoisoned => "database lock is unavailable; restart the app".into(),
            VocabErr::NotInit => "db not initialized, call setupDb first".into(),
            VocabErr::Import(s) => format!("import: {s}"),
            VocabErr::InvalidInput(s) => format!("invalid input: {s}"),
            VocabErr::ProfileCalcFailed(s) => format!("word profile calculation failed: {s}"),
        };
        Error::from_reason(msg)
    }
}

impl From<rusqlite::Error> for VocabErr {
    fn from(e: rusqlite::Error) -> Self {
        VocabErr::Sql(e)
    }
}

impl From<std::io::Error> for VocabErr {
    fn from(e: std::io::Error) -> Self {
        VocabErr::Io(e)
    }
}

impl From<serde_json::Error> for VocabErr {
    fn from(e: serde_json::Error) -> Self {
        VocabErr::Json(e)
    }
}

pub type VResult<T> = Result<T, VocabErr>;
