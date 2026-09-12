//! 词表导入：支持 txt/csv/json，自动检测分隔符

use rusqlite::params;
use std::io::BufRead;

use crate::database::{conn, require_mut};
use crate::error::{VResult, VocabErr};
use crate::models::ImportStats;

const NO_DEF: &str = "(释义待补充)"; // 没释义的先占位，答题时按需补全

pub fn import_wordlist(path: &str) -> VResult<ImportStats> {
    let extension = std::path::Path::new(path)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let pairs = if extension == "json" {
        parse_json(path)?
    } else if extension == "csv" {
        parse_csv(path)?
    } else {
        parse_txt(path)?
    };

    let total = pairs.len() as i64;
    let mut g = conn()?;
    let conn = require_mut(&mut g)?;

    let tx = conn.transaction()?;
    let mut imported = 0i64;
    let mut skipped = 0i64;
    {
        let mut stmt =
            tx.prepare_cached("INSERT OR IGNORE INTO words (term, meaning) VALUES (?1, ?2)")?;
        for (term, meaning) in &pairs {
            if stmt.execute(params![term, meaning])? == 1 {
                imported += 1;
            } else {
                skipped += 1;
            }
        }
    }
    tx.commit()?;

    Ok(ImportStats {
        imported,
        skipped,
        total,
    })
}

fn parse_json(path: &str) -> VResult<Vec<(String, String)>> {
    let content =
        std::fs::read_to_string(path).map_err(|e| VocabErr::Import(format!("read json: {e}")))?;
    let json: serde_json::Value =
        serde_json::from_str(&content).map_err(|e| VocabErr::Import(format!("parse json: {e}")))?;
    let arr = json
        .as_array()
        .ok_or_else(|| VocabErr::Import("root not array".into()))?;

    Ok(arr
        .iter()
        .filter_map(|obj| {
            let term = obj
                .get("term")
                .or_else(|| obj.get("word"))?
                .as_str()?
                .to_string();
            let meaning = obj
                .get("meaning")
                .and_then(|v| v.as_str())
                .unwrap_or(NO_DEF)
                .to_string();
            if term.is_empty() {
                None
            } else {
                Some((term, meaning))
            }
        })
        .collect())
}

fn parse_csv(path: &str) -> VResult<Vec<(String, String)>> {
    let file = std::fs::File::open(path)?;
    let reader = std::io::BufReader::new(file);
    let mut result = Vec::new();
    for line in reader.lines() {
        let line = line?;
        let mut parts = line.splitn(2, ',');
        let term = parts.next().unwrap_or_default().trim().to_string();
        if term.is_empty() {
            continue;
        }
        let meaning = parts
            .next()
            .map(|value| value.trim().to_string())
            .unwrap_or_else(|| NO_DEF.to_string());
        result.push((term, meaning));
    }
    Ok(result)
}

fn parse_txt(path: &str) -> VResult<Vec<(String, String)>> {
    let file = std::fs::File::open(path)?;
    let reader = std::io::BufReader::new(file);

    let mut result = Vec::new();
    for line in reader.lines() {
        let line = line.map_err(|e| VocabErr::Import(format!("read line: {e}")))?;
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }

        if let Some((t, m)) = try_split_by_sep(line) {
            result.push((t, m));
            continue;
        }

        if let Some((t, m)) = try_split_by_space(line) {
            result.push((t, m));
            continue;
        }

        let term = line.trim().to_string();
        if !term.is_empty() && term.len() < 100 {
            result.push((term, NO_DEF.to_string()));
        }
    }
    Ok(result)
}

fn try_split_by_sep(line: &str) -> Option<(String, String)> {
    for sep in ["：", ":", " - ", "\t"] {
        if let Some(idx) = line.find(sep) {
            // 音标里的冒号不是分隔符，比如 abandon [/əˈbændən/]: 放弃
            if (sep == ":" || sep == "：")
                && (line[..idx].contains('[') || line[..idx].contains('/'))
            {
                continue;
            }
            let term = line[..idx].trim().to_string();
            let meaning = line[idx + sep.len()..].trim().to_string();
            if !term.is_empty() {
                let m = if meaning.is_empty() {
                    NO_DEF.to_string()
                } else {
                    meaning
                };
                return Some((term, m));
            }
        }
    }
    None
}

fn try_split_by_space(line: &str) -> Option<(String, String)> {
    let idx = line.find(char::is_whitespace)?;
    let term = line[..idx].trim().to_string();
    let meaning = line[idx..].trim().to_string();

    let has_clue = meaning.chars().any(|c| {
        ('\u{4e00}'..='\u{9fff}').contains(&c)
            || c == '['
            || c == '【'
            || c == '('
            || c == '（'
            || c == '/'
            || c == '；'
            || c == ';'
    });

    if !term.is_empty() && has_clue {
        let m = if meaning.is_empty() {
            NO_DEF.to_string()
        } else {
            meaning
        };
        Some((term, m))
    } else {
        None
    }
}
