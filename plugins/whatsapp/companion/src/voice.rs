//! Voice calls: WhatsApp call audio ⇄ OpenAI Realtime.
//!
//! Audio never leaves this process except to the voice provider. Mercury is
//! asked two things over the plugin connection: whether to answer a call
//! (only the owner, decided by Mercury) and, mid-call, `ask_mercury`
//! questions, which run as a normal Mercury turn whose answer is spoken back.
//!
//! WhatsApp call audio (PCM path): 16 kHz mono i16, 960-sample (60 ms) frames.
//! OpenAI Realtime: 24 kHz mono i16, base64, any chunk size.

use std::collections::{HashMap, VecDeque};
use std::sync::Arc;
use std::time::{Duration, Instant};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as B64;
use serde_json::{Value, json};
use tokio::sync::{Mutex, mpsc};
use tokio_websockets::{ClientBuilder, Message};
use whatsapp_rust::async_channel;
use whatsapp_rust::futures::{SinkExt, StreamExt};
use whatsapp_rust::prelude::*;
use whatsapp_rust::types::call::{CallAction, IncomingCall};
use whatsapp_rust::voip::CallHandle;

use crate::{Out, State, log, phone_of};

const WA_RATE: u32 = 16_000;
const AI_RATE: u32 = 24_000;
const FRAME: usize = 960;
const RING_TIMEOUT: Duration = Duration::from_secs(45);
const ASK_TIMEOUT: Duration = Duration::from_secs(100);

/// Outcomes of outgoing calls, keyed by call id, fed from the client event bus.
pub type CallWatchers = Arc<Mutex<HashMap<String, mpsc::UnboundedSender<&'static str>>>>;

pub fn settings() -> Value {
    std::env::var("MERCURY_PLUGIN_SETTINGS").ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or(json!({}))
}

fn setting_str(key: &str, default: &str) -> String {
    settings().get(key).and_then(Value::as_str).filter(|s| !s.is_empty()).unwrap_or(default).to_string()
}

pub fn voice_ready() -> bool {
    std::env::var("MERCURY_PROVIDER_OPENAI_API_KEY").map(|k| !k.is_empty()).unwrap_or(false)
}

fn realtime_url() -> String {
    let base = std::env::var("MERCURY_PROVIDER_OPENAI_BASE_URL").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "https://api.openai.com/v1".into());
    let base = base.trim_end_matches('/');
    let ws = if let Some(rest) = base.strip_prefix("https://") { format!("wss://{rest}") } else if let Some(rest) = base.strip_prefix("http://") { format!("ws://{rest}") } else { base.to_string() };
    format!("{ws}/realtime?model={}", setting_str("voiceModel", "gpt-realtime"))
}

/// Linear resampling of mono i16 PCM.
pub fn resample(input: &[i16], from: u32, to: u32) -> Vec<i16> {
    if input.is_empty() || from == to {
        return input.to_vec();
    }
    let out_len = ((input.len() as u64 * to as u64) / from as u64).max(1) as usize;
    let step = from as f64 / to as f64;
    (0..out_len)
        .map(|i| {
            let pos = i as f64 * step;
            let idx = pos as usize;
            let frac = pos - idx as f64;
            let a = input[idx.min(input.len() - 1)] as f64;
            let b = input[(idx + 1).min(input.len() - 1)] as f64;
            (a + (b - a) * frac).round().clamp(i16::MIN as f64, i16::MAX as f64) as i16
        })
        .collect()
}

fn pcm_to_b64(samples: &[i16]) -> String {
    let mut bytes = Vec::with_capacity(samples.len() * 2);
    for s in samples {
        bytes.extend_from_slice(&s.to_le_bytes());
    }
    B64.encode(bytes)
}

fn b64_to_pcm(data: &str) -> Vec<i16> {
    let bytes = B64.decode(data).unwrap_or_default();
    bytes.chunks_exact(2).map(|c| i16::from_le_bytes([c[0], c[1]])).collect()
}

/// Feed call outcomes for outgoing calls to whoever placed them.
pub async fn route_call_event(watchers: &CallWatchers, call: &IncomingCall) {
    let (id, outcome) = match &call.action {
        CallAction::Accept { call_id, .. } => (call_id.clone(), "answered"),
        CallAction::Reject { call_id, reason, .. } => (call_id.clone(), if reason.is_none() { "declined" } else { "busy" }),
        CallAction::Terminate { call_id, .. } => (call_id.clone(), "ended"),
        _ => return,
    };
    if let Some(tx) = watchers.lock().await.get(&id) {
        let _ = tx.send(outcome);
    }
}

/// An incoming offer: ask Mercury whether to answer (owner only), then bridge it.
pub async fn on_offer(st: Arc<State>, client: Arc<Client>, call: Box<IncomingCall>) {
    let CallAction::Offer { call_id, caller_pn, is_video, group_jid, .. } = &call.action else { return };
    let from = call.from.to_string();
    let from_phone = caller_pn.as_ref().and_then(phone_of).or_else(|| phone_of(&call.from));
    let call_id = call_id.clone();

    if group_jid.is_some() || settings().get("answerCalls").and_then(Value::as_bool) == Some(false) {
        let _ = client.voip().reject(&call).await;
        return;
    }
    let decision = st
        .out
        .request("mercury/call/incoming", json!({ "callId": call_id, "from": from, "fromPhone": from_phone, "video": is_video, "voiceReady": voice_ready() }), Duration::from_secs(8))
        .await
        .unwrap_or_else(|e| json!({ "accept": false, "reason": e }));
    if decision.get("accept").and_then(Value::as_bool) != Some(true) {
        let _ = client.voip().reject(&call).await;
        return;
    }
    let instructions = decision.get("instructions").and_then(Value::as_str).unwrap_or("").to_string();

    let (mic_tx, mic_rx) = async_channel::bounded::<Vec<i16>>(3);
    let (spk_tx, spk_rx) = async_channel::bounded::<Vec<i16>>(64);
    let handle = match client.voip().accept(&call).audio(mic_rx, spk_tx).start().await {
        Ok(h) => h,
        Err(e) => {
            log(format!("accept failed: {e}"));
            st.out.notify("mercury/call/ended", json!({ "callId": call_id, "direction": "incoming", "outcome": "failed", "detail": e.to_string(), "durationSec": 0, "transcript": [] }));
            return;
        }
    };
    let opener = "The owner just called you. Greet them briefly by name if you know it, and ask how you can help.".to_string();
    run_session(st, handle, mic_tx, spk_rx, call_id, "incoming", instructions, opener).await;
}

/// The `call_owner` tool: ring the owner and, if they answer, talk.
pub async fn call_owner(st: Arc<State>, args: &Value) -> Result<String, String> {
    let reason = args.get("reason").and_then(Value::as_str).unwrap_or("").trim().to_string();
    if reason.is_empty() {
        return Err("reason is required".into());
    }
    if !voice_ready() {
        return Err("Voice calls need an OpenAI provider. Add your OpenAI key once in Mercury's dashboard (Providers) or with `mercury doctor`.".into());
    }
    let owner: String = setting_str("owner", "").chars().filter(char::is_ascii_digit).collect();
    if owner.len() < 6 {
        return Err("No owner number is set. Run: mercury plugins set whatsapp owner +<number>".into());
    }
    // Rate limit: a looping task must never spam the owner with calls.
    let max_per_hour = settings().get("maxCallsPerHour").and_then(Value::as_f64).unwrap_or(4.0).max(0.0) as usize;
    {
        let mut recent = st.recent_calls.lock().await;
        let hour_ago = Instant::now() - Duration::from_secs(3600);
        recent.retain(|t| *t > hour_ago);
        if recent.len() >= max_per_hour {
            return Err(format!("Not calling: already called the owner {} times in the last hour (limit {max_per_hour}). Send a message instead.", recent.len()));
        }
        recent.push(Instant::now());
    }
    let client = st.client.lock().await.clone().ok_or("WhatsApp is not linked.")?;
    let jid: Jid = format!("{owner}@s.whatsapp.net").parse().map_err(|e| format!("bad owner number: {e}"))?;

    let (mic_tx, mic_rx) = async_channel::bounded::<Vec<i16>>(3);
    let (spk_tx, spk_rx) = async_channel::bounded::<Vec<i16>>(64);
    let handle = client.voip().call(&jid).audio(mic_rx, spk_tx).start().await.map_err(|e| format!("couldn't place the call: {e}"))?;
    let call_id = handle.call_id().to_string();

    let (tx, mut rx) = mpsc::unbounded_channel();
    st.call_watchers.lock().await.insert(call_id.clone(), tx);
    let outcome = tokio::time::timeout(RING_TIMEOUT, async {
        loop {
            match rx.recv().await {
                Some("answered") => return "answered",
                Some("busy") => continue, // one of their devices can't take it; others keep ringing
                Some(other) => return other,
                None => return "failed",
            }
        }
    })
    .await
    .unwrap_or("no_answer");
    st.call_watchers.lock().await.remove(&call_id);

    if outcome != "answered" {
        let _ = handle.terminate().await;
        let outcome = if outcome == "ended" { "no_answer" } else { outcome };
        st.out.notify("mercury/call/ended", json!({ "callId": call_id, "direction": "outgoing", "outcome": outcome, "reason": reason, "durationSec": 0, "transcript": [] }));
        return Ok(format!("{outcome}: the owner did not pick up. Send them a message instead."));
    }
    let briefing = st.out.request("mercury/call/briefing", json!({ "callId": call_id }), Duration::from_secs(5)).await.unwrap_or(json!({}));
    let instructions = briefing.get("instructions").and_then(Value::as_str).unwrap_or("").to_string();
    let opener = format!("You called the owner and they answered. Why you called: {reason}. Greet them, explain why you called in one or two sentences, and help with whatever they need.");
    let st2 = st.clone();
    tokio::spawn(async move { run_session(st2, handle, mic_tx, spk_rx, call_id, "outgoing", instructions, opener).await });
    Ok("answered: the owner picked up and the call is in progress. A summary will be sent when it ends.".into())
}

fn session_config(instructions: &str) -> Value {
    let base = "You are Mercury, the user's AI assistant, talking on a WhatsApp voice call. \
        Speak naturally and briefly: one or two sentences at a time, no lists, no markdown, no URLs read aloud. \
        For anything that needs Mercury's memory, files, tools, the web, or doing something, call ask_mercury with a clear question, \
        and say a short filler like 'one moment' first. Nothing that needs the user's approval can be done during a call; \
        if ask_mercury says so, offer to do it by message instead. When the user says goodbye or is done, say goodbye and call end_call.";
    json!({
        "type": "session.update",
        "session": {
            "type": "realtime",
            "instructions": if instructions.is_empty() { base.to_string() } else { format!("{base}\n\n{instructions}") },
            "audio": {
                "input": {
                    "format": { "type": "audio/pcm", "rate": AI_RATE },
                    "turn_detection": { "type": "server_vad", "interrupt_response": true, "create_response": true },
                    "transcription": { "model": "gpt-4o-mini-transcribe" },
                },
                "output": { "format": { "type": "audio/pcm", "rate": AI_RATE }, "voice": setting_str("voice", "marin") },
            },
            "tools": [
                {
                    "type": "function",
                    "name": "ask_mercury",
                    "description": "Ask Mercury (with its memory, tools and files) a question or to do something. Returns the answer to speak back.",
                    "parameters": { "type": "object", "properties": { "question": { "type": "string" } }, "required": ["question"] },
                },
                { "type": "function", "name": "end_call", "description": "Hang up after saying goodbye.", "parameters": { "type": "object", "properties": {} } },
            ],
        },
    })
}

#[allow(clippy::too_many_arguments)]
async fn run_session(
    st: Arc<State>,
    handle: CallHandle,
    mic_tx: async_channel::Sender<Vec<i16>>,
    spk_rx: async_channel::Receiver<Vec<i16>>,
    call_id: String,
    direction: &'static str,
    instructions: String,
    opener: String,
) {
    let started = Instant::now();
    let transcript: Arc<Mutex<Vec<Value>>> = Arc::new(Mutex::new(Vec::new()));
    let outcome = match bridge(&st, &handle, mic_tx, spk_rx, &call_id, &instructions, &opener, transcript.clone()).await {
        Ok(()) => "completed".to_string(),
        Err(e) => {
            log(format!("voice session ended with an error: {e}"));
            // Tell the caller something went wrong rather than leaving silence.
            let _ = handle.terminate().await;
            format!("failed: {e}")
        }
    };
    let _ = tokio::time::timeout(Duration::from_secs(5), handle.terminate()).await;
    let t = transcript.lock().await.clone();
    st.out.notify("mercury/call/ended", json!({
        "callId": call_id,
        "direction": direction,
        "outcome": outcome,
        "durationSec": started.elapsed().as_secs(),
        "transcript": t,
    }));
}

#[allow(clippy::too_many_arguments)]
async fn bridge(
    st: &Arc<State>,
    handle: &CallHandle,
    mic_tx: async_channel::Sender<Vec<i16>>,
    spk_rx: async_channel::Receiver<Vec<i16>>,
    call_id: &str,
    instructions: &str,
    opener: &str,
    transcript: Arc<Mutex<Vec<Value>>>,
) -> Result<(), String> {
    let key = std::env::var("MERCURY_PROVIDER_OPENAI_API_KEY").map_err(|_| "no OpenAI key".to_string())?;
    let uri: http::Uri = realtime_url().parse().map_err(|e| format!("bad realtime URL: {e}"))?;
    let auth = http::HeaderValue::from_str(&format!("Bearer {key}")).map_err(|e| e.to_string())?;
    let (ws, _) = ClientBuilder::from_uri(uri)
        .add_header(http::header::AUTHORIZATION, auth)
        .map_err(|e| e.to_string())?
        .connect()
        .await
        .map_err(|e| format!("couldn't reach the voice model: {e}"))?;
    let (mut ws_tx, mut ws_rx) = ws.split();

    let (send_q, mut send_rx) = mpsc::unbounded_channel::<Value>();
    // Single writer for the model socket.
    let writer = tokio::spawn(async move {
        while let Some(v) = send_rx.recv().await {
            if ws_tx.send(Message::text(v.to_string())).await.is_err() {
                break;
            }
        }
        let _ = ws_tx.close().await;
    });

    let _ = send_q.send(session_config(instructions));
    let _ = send_q.send(json!({ "type": "conversation.item.create", "item": { "type": "message", "role": "user", "content": [{ "type": "input_text", "text": format!("[Call context, not spoken by the user] {opener}") }] } }));
    let _ = send_q.send(json!({ "type": "response.create" }));

    // Caller → model.
    let up_q = send_q.clone();
    let uplink = tokio::spawn(async move {
        while let Ok(frame) = spk_rx.recv().await {
            let up = resample(&frame, WA_RATE, AI_RATE);
            if up_q.send(json!({ "type": "input_audio_buffer.append", "audio": pcm_to_b64(&up) })).is_err() {
                break;
            }
        }
    });

    // Model → caller, paced at one 60 ms frame per tick.
    let playout: Arc<std::sync::Mutex<VecDeque<i16>>> = Arc::new(std::sync::Mutex::new(VecDeque::new()));
    let play = playout.clone();
    let pacer = tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_millis(60));
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            tick.tick().await;
            let frame: Vec<i16> = {
                let mut q = play.lock().unwrap();
                let n = q.len().min(FRAME);
                let mut f: Vec<i16> = q.drain(..n).collect();
                f.resize(FRAME, 0);
                f
            };
            if mic_tx.send(frame).await.is_err() {
                break;
            }
        }
    });

    let max_minutes = settings().get("maxCallMinutes").and_then(Value::as_f64).unwrap_or(15.0).clamp(1.0, 120.0);
    let deadline = tokio::time::sleep(Duration::from_secs_f64(max_minutes * 60.0));
    tokio::pin!(deadline);
    let ended = handle.wait_ended();
    tokio::pin!(ended);
    let mut hang_up = false;

    let result = loop {
        tokio::select! {
            _ = &mut ended => break Ok(()),
            _ = &mut deadline => { hang_up = true; break Ok(()) }
            msg = ws_rx.next() => {
                let Some(Ok(msg)) = msg else { break Err("the voice model disconnected".to_string()) };
                if msg.is_close() { break Err("the voice model closed the session".to_string()); }
                let Some(text) = msg.as_text() else { continue };
                let Ok(ev) = serde_json::from_str::<Value>(text) else { continue };
                let kind = ev.get("type").and_then(Value::as_str).unwrap_or("");
                match kind {
                    "response.output_audio.delta" | "response.audio.delta" => {
                        if let Some(d) = ev.get("delta").and_then(Value::as_str) {
                            let down = resample(&b64_to_pcm(d), AI_RATE, WA_RATE);
                            playout.lock().unwrap().extend(down);
                        }
                    }
                    // The caller started talking: stop speaking over them.
                    "input_audio_buffer.speech_started" => playout.lock().unwrap().clear(),
                    "conversation.item.input_audio_transcription.completed" => {
                        if let Some(t) = ev.get("transcript").and_then(Value::as_str) {
                            transcript.lock().await.push(json!({ "role": "owner", "text": t.trim() }));
                        }
                    }
                    "response.output_audio_transcript.done" | "response.audio_transcript.done" => {
                        if let Some(t) = ev.get("transcript").and_then(Value::as_str) {
                            transcript.lock().await.push(json!({ "role": "mercury", "text": t.trim() }));
                        }
                    }
                    "response.function_call_arguments.done" => {
                        let name = ev.get("name").and_then(Value::as_str).unwrap_or("").to_string();
                        let fc_id = ev.get("call_id").and_then(Value::as_str).unwrap_or("").to_string();
                        let args: Value = ev.get("arguments").and_then(Value::as_str).and_then(|a| serde_json::from_str(a).ok()).unwrap_or(json!({}));
                        if name == "end_call" {
                            // Let the goodbye finish playing.
                            for _ in 0..50 {
                                if playout.lock().unwrap().is_empty() { break; }
                                tokio::time::sleep(Duration::from_millis(100)).await;
                            }
                            hang_up = true;
                            break Ok(());
                        }
                        if name == "ask_mercury" {
                            let q = args.get("question").and_then(Value::as_str).unwrap_or("").to_string();
                            transcript.lock().await.push(json!({ "role": "ask_mercury", "text": q }));
                            let st2 = st.clone();
                            let tx2 = send_q.clone();
                            let call_id2 = call_id.to_string();
                            tokio::spawn(async move {
                                let answer = st2.out.request("mercury/call/ask", json!({ "callId": call_id2, "question": q }), ASK_TIMEOUT)
                                    .await
                                    .ok()
                                    .and_then(|v| v.get("answer").and_then(Value::as_str).map(str::to_string))
                                    .unwrap_or_else(|| "Mercury didn't answer in time. It will send the answer by message.".into());
                                let _ = tx2.send(json!({ "type": "conversation.item.create", "item": { "type": "function_call_output", "call_id": fc_id, "output": answer } }));
                                let _ = tx2.send(json!({ "type": "response.create" }));
                            });
                        }
                    }
                    "error" => log(format!("voice model error: {}", ev.get("error").map(|e| e.to_string()).unwrap_or_default())),
                    _ => {}
                }
            }
        }
    };

    uplink.abort();
    pacer.abort();
    drop(send_q);
    let _ = tokio::time::timeout(Duration::from_secs(2), writer).await;
    if hang_up {
        let _ = handle.terminate().await;
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resample_lengths() {
        assert_eq!(resample(&[0i16; 960], WA_RATE, AI_RATE).len(), 1440);
        assert_eq!(resample(&[0i16; 1440], AI_RATE, WA_RATE).len(), 960);
    }

    #[test]
    fn pcm_round_trip() {
        let s = vec![0i16, 1, -1, i16::MAX, i16::MIN];
        assert_eq!(b64_to_pcm(&pcm_to_b64(&s)), s);
    }
}
