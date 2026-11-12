//! Prompt families. Each module owns its system prompt, its JSON schema and a
//! typed parse of the answer, so a prompt and the code reading it change
//! together. Schemas follow the structured-output rules: every object has
//! `additionalProperties: false` and lists all properties as required;
//! optional values are `anyOf` with null; no length or range keywords
//! (limits are enforced in code after parsing).

pub mod cv_parse;

use serde_json::{json, Value};

pub fn string() -> Value {
    json!({ "type": "string" })
}

pub fn nullable(schema: Value) -> Value {
    json!({ "anyOf": [schema, { "type": "null" }] })
}

pub fn array(items: Value) -> Value {
    json!({ "type": "array", "items": items })
}

/// A closed object: every listed property required, nothing else allowed.
pub fn object(props: &[(&str, Value)]) -> Value {
    let mut properties = serde_json::Map::new();
    for (k, v) in props {
        properties.insert((*k).to_string(), v.clone());
    }
    let required: Vec<&str> = props.iter().map(|(k, _)| *k).collect();
    json!({
        "type": "object",
        "properties": properties,
        "required": required,
        "additionalProperties": false
    })
}

/// True when every object in the schema is closed. Used by tests to keep
/// schemas valid for structured outputs.
pub fn all_objects_closed(v: &Value) -> bool {
    match v {
        Value::Object(m) => {
            let closed = m.get("type") != Some(&json!("object"))
                || m.get("additionalProperties") == Some(&json!(false));
            closed && m.values().all(all_objects_closed)
        }
        Value::Array(a) => a.iter().all(all_objects_closed),
        _ => true,
    }
}
