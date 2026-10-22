//! The part of Optimus that touches the computer: screen and input (ops.rs),
//! the talk key (hotkey.rs) and voice sessions (voice.rs).
//!
//! On macOS it runs inside Optimus.app; elsewhere on a thread of the plugin
//! process. Either way it talks to the plugin side (main.rs) with JSON
//! messages, one per line on macOS:
//!
//!   plugin → core   {"op": {"id": 1, "name": "look", "args": {…}}}
//!                   {"mercury": <JSON-RPC from Mercury: replies to our requests, mercury/call/* notifications>}
//!                   {"quit": true}
//!   core → plugin   {"opResult": {"id": 1, "ok": {…}}} or {"opResult": {"id": 1, "err": "…"}}
//!                   {"mercury": <JSON-RPC for Mercury>}

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{Value, json};
use tokio::sync::oneshot;

use crate::ops::Ops;

pub fn log(msg: impl AsRef<str>) {
    eprintln!("optimus: {}", msg.as_ref());
}

pub fn settings() -> Value {
    std::env::var("MERCURY_PLUGIN_SETTINGS").ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or(json!({}))
}

pub fn voice_enabled() -> bool {
    !matches!(settings().get("mode").and_then(Value::as_str), Some("chat"))
}

type Pending = Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>;

/// Requests and notifications to Mercury, through the plugin process.
pub struct Out {
    send: Box<dyn Fn(Value) + Send + Sync>,
    pending: Pending,
    next: AtomicU64,
}

impl Out {
    pub fn notify(&self, method: &str, params: Value) {
        (self.send)(json!({ "mercury": { "jsonrpc": "2.0", "method": method, "params": params } }));
    }

    pub async fn request(&self, method: &str, params: Value, timeout: Duration) -> Result<Value, String> {
        let n = self.next.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(n, tx);
        (self.send)(json!({ "mercury": { "jsonrpc": "2.0", "id": format!("oc-{n}"), "method": method, "params": params } }));
        let r = tokio::time::timeout(timeout, rx).await;
        self.pending.lock().unwrap().remove(&n);
        match r {
            Ok(Ok(v)) => v,
            Ok(Err(_)) => Err("Mercury went away".into()),
            Err(_) => Err(format!("{method} timed out")),
        }
    }

    fn resolve(&self, id: &str, result: Result<Value, String>) {
        let Some(n) = id.strip_prefix("oc-").and_then(|n| n.parse::<u64>().ok()) else { return };
        if let Some(tx) = self.pending.lock().unwrap().remove(&n) {
            let _ = tx.send(result);
        }
    }

    fn op_result(&self, id: u64, r: Result<Value, String>) {
        (self.send)(match r {
            Ok(v) => json!({ "opResult": { "id": id, "ok": v } }),
            Err(e) => json!({ "opResult": { "id": id, "err": e } }),
        });
    }
}

pub struct Shared {
    pub out: Out,
    pub rt: tokio::runtime::Handle,
    pub ops: Mutex<Ops>,
    /// What Mercury is doing right now for a session's question (mercury/call/progress).
    pub call_activity: Mutex<HashMap<String, String>>,
    /// Things the voice should mention (an approval answered elsewhere, …).
    pub call_context: Mutex<HashMap<String, Vec<String>>>,
    /// Approvals Mercury is waiting on, per session: (approval id, what for).
    pub call_approvals: Mutex<HashMap<String, Vec<(String, String)>>>,
    /// The live voice session, if any.
    pub session: Mutex<Option<crate::voice::SessionCtl>>,
    /// How the talk key reads, e.g. "Control+Option+M" (empty when there's none).
    pub hotkey_label: Mutex<String>,
}

/// Run the core until the plugin side goes away.
pub fn run(inbox: std::sync::mpsc::Receiver<Value>, send: impl Fn(Value) + Send + Sync + 'static) {
    let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().expect("tokio runtime");
    let shared = Arc::new(Shared {
        out: Out { send: Box::new(send), pending: Mutex::new(HashMap::new()), next: AtomicU64::new(1) },
        rt: rt.handle().clone(),
        ops: Mutex::new(Ops::new()),
        call_activity: Mutex::new(HashMap::new()),
        call_context: Mutex::new(HashMap::new()),
        call_approvals: Mutex::new(HashMap::new()),
        session: Mutex::new(None),
        hotkey_label: Mutex::new(String::new()),
    });

    start_hotkey(&shared);

    for msg in inbox {
        if msg.get("quit").is_some() {
            break;
        }
        if let Some(op) = msg.get("op") {
            let id = op["id"].as_u64().unwrap_or(0);
            let name = op["name"].as_str().unwrap_or("").to_string();
            let args = op["args"].clone();
            let sh = shared.clone();
            if name == "listen" {
                rt.spawn(async move {
                    let r = crate::voice::press(sh.clone(), true).await;
                    sh.out.op_result(id, r.map(|text| json!({ "text": text })));
                });
                continue;
            }
            rt.spawn_blocking(move || {
                let r = sh.ops.lock().unwrap_or_else(|e| e.into_inner()).run(&name, &args);
                sh.out.op_result(id, r);
            });
            continue;
        }
        if let Some(m) = msg.get("mercury") {
            on_mercury(&shared, m);
        }
    }
    // Stop any live session cleanly before exiting.
    if let Some(s) = shared.session.lock().unwrap().take() {
        s.stop();
    }
    rt.shutdown_timeout(Duration::from_secs(2));
}

fn start_hotkey(shared: &Arc<Shared>) {
    let status = |detail: String| {
        shared.out.notify("mercury/channel/status", json!({ "state": "connected", "account": "this computer", "detail": detail }));
    };
    if !voice_enabled() {
        status("Chat mode: ask Mercury in any chat to use the screen.".into());
        return;
    }
    let spec = settings().get("hotkey").and_then(Value::as_str).filter(|s| !s.trim().is_empty()).unwrap_or("ctrl+alt+m").to_string();
    let hk = match crate::hotkey::parse(&spec) {
        Ok(h) => h,
        Err(e) => {
            log(format!("talk key: {e}"));
            status(format!("Talk key not set: {e}. Fix it in /plugins optimus."));
            return;
        }
    };
    let label = hk.to_string();
    let sh = shared.clone();
    match crate::hotkey::listen(hk, move || {
        let sh2 = sh.clone();
        sh.rt.spawn(async move {
            if let Err(e) = crate::voice::press(sh2.clone(), false).await {
                log(format!("listening: {e}"));
            }
        });
    }) {
        Ok(()) => {
            *shared.hotkey_label.lock().unwrap() = label.clone();
            log(format!("press {label} to talk"));
            status(format!("Press {label} to talk; press it again to stop."));
        }
        Err(e) => {
            log(format!("talk key {label}: {e}"));
            status(format!("Talk key {label} isn't working: {e}"));
        }
    }
}

fn on_mercury(shared: &Arc<Shared>, msg: &Value) {
    // A reply to one of our requests.
    if let Some(id) = msg.get("id").and_then(Value::as_str) {
        if msg.get("method").is_none() {
            let r = match (msg.get("result"), msg.get("error")) {
                (Some(r), _) => Ok(r.clone()),
                (_, Some(e)) => Err(e.get("message").and_then(Value::as_str).unwrap_or("error").to_string()),
                _ => Err("empty reply".into()),
            };
            shared.out.resolve(id, r);
            return;
        }
    }
    let method = msg.get("method").and_then(Value::as_str).unwrap_or("");
    let p = msg.get("params").cloned().unwrap_or(Value::Null);
    let call = p.get("callId").and_then(Value::as_str).unwrap_or("").to_string();
    match method {
        "mercury/call/progress" => {
            if let Some(a) = p.get("activity").and_then(Value::as_str) {
                shared.call_activity.lock().unwrap().insert(call, a.chars().take(80).collect());
            }
        }
        "mercury/call/approval" => {
            if let (Some(id), Some(prompt)) = (p.get("approvalId").and_then(Value::as_str), p.get("prompt").and_then(Value::as_str)) {
                shared.call_approvals.lock().unwrap().entry(call).or_default().push((id.to_string(), prompt.chars().take(600).collect()));
            }
        }
        "mercury/call/approval-resolved" => {
            let Some(id) = p.get("approvalId").and_then(Value::as_str) else { return };
            if let Some(list) = shared.call_approvals.lock().unwrap().get_mut(&call) {
                list.retain(|(a, _)| a != id);
            }
            if p.get("via").and_then(Value::as_str) != Some("voice") {
                let note = format!("RESOLVED:{id}:Nobody answered that approval in time, so it wasn't done. Offer to try again.");
                shared.call_context.lock().unwrap().entry(call).or_default().push(note);
            }
        }
        "mercury/call/context" => {
            if let Some(t) = p.get("text").and_then(Value::as_str) {
                shared.call_context.lock().unwrap().entry(call).or_default().push(t.chars().take(400).collect());
            }
        }
        _ => {}
    }
}
