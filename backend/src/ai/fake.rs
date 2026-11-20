//! Deterministic stand-in for tests: canned answers per task, and a record of
//! every request so tests can assert on what was sent.

use std::collections::HashMap;
use std::sync::Mutex;

use serde_json::Value;

use super::{Llm, LlmError, LlmFuture, LlmRequest, LlmResponse, Usage};

#[derive(Default)]
pub struct FakeLlm {
    answers: Mutex<HashMap<&'static str, Result<Value, LlmError>>>,
    requests: Mutex<Vec<LlmRequest>>,
}

impl FakeLlm {
    pub fn new() -> Self {
        Self::default()
    }

    /// Answer every `task` call with `value`.
    pub fn answer(&self, task: &'static str, value: Value) {
        self.answers
            .lock()
            .expect("fake lock")
            .insert(task, Ok(value));
    }

    /// Fail every `task` call with `err`.
    pub fn fail(&self, task: &'static str, err: LlmError) {
        self.answers
            .lock()
            .expect("fake lock")
            .insert(task, Err(err));
    }

    pub fn requests(&self) -> Vec<LlmRequest> {
        self.requests.lock().expect("fake lock").clone()
    }

    pub fn calls(&self, task: &str) -> usize {
        self.requests().iter().filter(|r| r.task == task).count()
    }
}

impl Llm for FakeLlm {
    fn complete(&self, req: LlmRequest) -> LlmFuture<'_> {
        Box::pin(async move {
            let task = req.task;
            self.requests.lock().expect("fake lock").push(req);
            let answer = self.answers.lock().expect("fake lock").get(task).cloned();
            match answer {
                Some(Ok(value)) => Ok(LlmResponse {
                    value,
                    model: "fake-model".into(),
                    usage: Usage {
                        input_tokens: 1000,
                        output_tokens: 200,
                        ..Usage::default()
                    },
                }),
                Some(Err(e)) => Err(e),
                None => Err(LlmError::Upstream(format!(
                    "FakeLlm has no answer for task `{task}`"
                ))),
            }
        })
    }
}
