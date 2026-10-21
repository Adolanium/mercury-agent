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
// Long enough for a turn that waits on the owner's approval; Mercury itself replies
// "still working" well before this when a turn is merely slow.
const ASK_TIMEOUT: Duration = Duration::from_secs(300);

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
        You don't know today's news or anything current yourself: for news, facts that may have changed, the user's own things \
        (memory, files, calendar) or doing something, call ask_mercury with a clear, complete question; Mercury searches the web and uses its tools. \
        Before calling it for anything that searches the web or reads pages, tell the user it can take a few seconds and they can stay on the line \
        (for example: 'Let me look that up, it'll take a few seconds, stay with me'). Then speak its answer in your own words. \
        If you get a status update while Mercury is still working, give the user one short, natural sentence about it so they know you're still there. \
        The user can send photos and documents in the WhatsApp chat during the call: Mercury can see them, so for 'what's in this photo?' call ask_mercury. \
        Some actions need the user's approval. When you get an approval request, ask the user plainly whether to go ahead, wait for their answer, \
        then call answer_approval. Never answer an approval yourself: only the user's own words count. \
        Only actions that change something need the user's approval, which can't be given on a call; if ask_mercury says so, offer to do it by message. When the user says goodbye or is done, say goodbye and call end_call.";
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
                {
                    "type": "function",
                    "name": "answer_approval",
                    "description": "Report the user's answer to the approval you just asked them about. Only call it after they answered out loud.",
                    "parameters": { "type": "object", "properties": { "approved": { "type": "boolean", "description": "true only if the user clearly said yes" } }, "required": ["approved"] },
                },
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

    // Questions Mercury is still working on: (asked at, last spoken update, updates so far).
    let pending: Arc<std::sync::Mutex<HashMap<String, (Instant, Instant, u32)>>> = Arc::new(std::sync::Mutex::new(HashMap::new()));
    let mut responding = false;
    // Answers from Mercury, spoken as soon as the voice is free (only one response may be active).
    let (answer_tx, mut answer_rx) = mpsc::unbounded_channel::<(String, String)>();
    let mut ready_answers: VecDeque<(String, String)> = VecDeque::new();
    // The approval being asked out loud right now, and what the user has said since (transcripts).
    let mut awaiting: Option<(String, Instant)> = None;
    let mut user_said: Vec<(Instant, String)> = Vec::new();
    // A spoken "yes" waiting for its transcript: (function call id, approval id, asked at, deadline).
    let mut verifying: Option<(String, String, Instant, Instant)> = None;
    let mut status_tick = tokio::time::interval(Duration::from_secs(1));
    status_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

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
            Some(a) = answer_rx.recv() => {
                ready_answers.push_back(a);
                if !responding { deliver(&send_q, &mut ready_answers, &mut responding); }
            }
            _ = status_tick.tick() => {
                if let Some((fc, _id, _asked, deadline)) = verifying.clone() {
                    if Instant::now() >= deadline {
                        verifying = None;
                        ready_answers.push_back((fc, "Not approved: the user hasn't clearly said yes in their own words. Ask them again, or they can reply 1 in the WhatsApp chat.".to_string()));
                    }
                }
                if !responding && !ready_answers.is_empty() {
                    deliver(&send_q, &mut ready_answers, &mut responding);
                    continue;
                }
                if responding || !playout.lock().unwrap().is_empty() { continue; }
                // Mercury needs the user's go-ahead: ask out loud.
                if awaiting.is_none() {
                    let next = st.call_approvals.lock().unwrap().get_mut(call_id).and_then(|l| if l.is_empty() { None } else { Some(l.remove(0)) });
                    if let Some((id, prompt)) = next {
                        awaiting = Some((id, Instant::now()));
                        let text = format!("[Approval needed, not said by the user] Mercury wants to: {prompt}. Ask the user plainly, in one or two sentences, whether to go ahead. Then wait for their answer and call answer_approval. (They can also reply 1 in the WhatsApp chat.)");
                        let _ = send_q.send(json!({ "type": "conversation.item.create", "item": { "type": "message", "role": "user", "content": [{ "type": "input_text", "text": text }] } }));
                        let _ = send_q.send(json!({ "type": "response.create" }));
                        responding = true;
                        continue;
                    }
                }
                // Something arrived in the chat (a photo, a document, an approval given there): let the voice mention it.
                let context = st.call_context.lock().unwrap().remove(call_id);
                if let Some(mut notes) = context.filter(|n| !n.is_empty()) {
                    for n in notes.iter_mut() {
                        if let Some(rest) = n.strip_prefix("RESOLVED:") {
                            let (id, text) = rest.split_once(':').unwrap_or(("", rest));
                            if awaiting.as_ref().map(|(a, _)| a == id).unwrap_or(false) { awaiting = None; }
                            *n = text.to_string();
                        }
                    }
                    let text = format!("[Status update, not said by the user] {} Acknowledge it in one short sentence (for example 'Got your photo, want me to take a look?'), unless they're mid-sentence.", notes.join(" "));
                    let _ = send_q.send(json!({ "type": "conversation.item.create", "item": { "type": "message", "role": "user", "content": [{ "type": "input_text", "text": text }] } }));
                    let _ = send_q.send(json!({ "type": "response.create" }));
                    responding = true;
                    continue;
                }
                // Keep the caller company while a lookup runs: a short spoken update
                // after ~8s, then every ~14s, never over the model or the caller.
                let due = {
                    let mut p = pending.lock().unwrap();
                    let now = Instant::now();
                    p.iter_mut().find_map(|(_, (asked, last, n))| {
                        let wait = if *n == 0 { Duration::from_secs(8) } else { Duration::from_secs(14) };
                        if *n < 8 && now.duration_since(if *n == 0 { *asked } else { *last }) >= wait {
                            *last = now;
                            *n += 1;
                            Some((*n, now.duration_since(*asked).as_secs()))
                        } else { None }
                    })
                };
                if let Some((n, secs)) = due {
                    let doing = st.call_activity.lock().unwrap().get(call_id).cloned().unwrap_or_else(|| "working on it".into());
                    let text = if n == 1 {
                        format!("[Status update, not said by the user] Mercury is still {doing}. Tell the user in one short sentence that it's taking a few seconds and they can stay on the line.")
                    } else {
                        format!("[Status update, not said by the user] After {secs} seconds Mercury is still {doing}. Give the user one short, natural update (don't repeat yourself) so they know you're still there.")
                    };
                    let _ = send_q.send(json!({ "type": "conversation.item.create", "item": { "type": "message", "role": "user", "content": [{ "type": "input_text", "text": text }] } }));
                    let _ = send_q.send(json!({ "type": "response.create" }));
                    responding = true;
                }
            }
            msg = ws_rx.next() => {
                let Some(Ok(msg)) = msg else { break Err("the voice model disconnected".to_string()) };
                if msg.is_close() {
                    let reason = msg.as_close().map(|(_, r)| r.to_string()).unwrap_or_default();
                    break Err(explain_close(&reason));
                }
                let Some(text) = msg.as_text() else { continue };
                let Ok(ev) = serde_json::from_str::<Value>(text) else { continue };
                let kind = ev.get("type").and_then(Value::as_str).unwrap_or("");
                match kind {
                    "response.created" => responding = true,
                    "response.done" | "response.cancelled" => {
                        responding = false;
                        if !ready_answers.is_empty() { deliver(&send_q, &mut ready_answers, &mut responding); }
                    }
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
                            user_said.push((Instant::now(), t.trim().to_string()));
                            if user_said.len() > 20 { user_said.remove(0); }
                            if let Some((fc, id, asked_at, _)) = verifying.clone() {
                                if let Some(v) = spoken_verdict(&user_said, asked_at) {
                                    verifying = None;
                                    awaiting = None;
                                    let out = finalize_approval(st, call_id, &id, v).await;
                                    ready_answers.push_back((fc, out));
                                    if !responding { deliver(&send_q, &mut ready_answers, &mut responding); }
                                }
                            }
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
                        if name == "answer_approval" {
                            let approved = args.get("approved").and_then(Value::as_bool).unwrap_or(false);
                            match awaiting.clone() {
                                None => {
                                    ready_answers.push_back((fc_id, "No approval is waiting right now.".to_string()));
                                }
                                Some((id, asked_at)) => {
                                    // The user's own words decide, not the model. Transcription can lag the
                                    // model a little, so an undecided "yes" waits up to 3s for the transcript.
                                    match (approved, spoken_verdict(&user_said, asked_at)) {
                                        (false, _) | (true, Some(false)) => {
                                            awaiting = None;
                                            let out = finalize_approval(st, call_id, &id, false).await;
                                            ready_answers.push_back((fc_id, out));
                                        }
                                        (true, Some(true)) => {
                                            awaiting = None;
                                            let out = finalize_approval(st, call_id, &id, true).await;
                                            ready_answers.push_back((fc_id, out));
                                        }
                                        (true, None) => {
                                            verifying = Some((fc_id, id, asked_at, Instant::now() + Duration::from_secs(3)));
                                        }
                                    }
                                }
                            }
                            if !responding { deliver(&send_q, &mut ready_answers, &mut responding); }
                            continue;
                        }
                        if name == "ask_mercury" {
                            let q = args.get("question").and_then(Value::as_str).unwrap_or("").to_string();
                            transcript.lock().await.push(json!({ "role": "ask_mercury", "text": q }));
                            let st2 = st.clone();
                            let tx2 = answer_tx.clone();
                            let call_id2 = call_id.to_string();
                            let now = Instant::now();
                            pending.lock().unwrap().insert(fc_id.clone(), (now, now, 0));
                            st.call_activity.lock().unwrap().remove(call_id);
                            let pending2 = pending.clone();
                            tokio::spawn(async move {
                                let answer = st2.out.request("mercury/call/ask", json!({ "callId": call_id2, "question": q }), ASK_TIMEOUT)
                                    .await
                                    .ok()
                                    .and_then(|v| v.get("answer").and_then(Value::as_str).map(str::to_string))
                                    .unwrap_or_else(|| "Mercury didn't answer in time. It will send the answer by message.".into());
                                pending2.lock().unwrap().remove(&fc_id);
                                let _ = tx2.send((fc_id, answer));
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

async fn finalize_approval(st: &Arc<State>, call_id: &str, approval_id: &str, yes: bool) -> String {
    match st.out.request("mercury/call/approve", json!({ "callId": call_id, "approvalId": approval_id, "approved": yes }), Duration::from_secs(10)).await {
        Ok(v) if v.get("ok").and_then(Value::as_bool) == Some(true) => {
            if yes { "Approved. Mercury is carrying on; tell the user briefly.".into() } else { "Declined. Tell the user it won't be done.".into() }
        }
        Ok(v) => format!("That approval was already settled ({}).", v.get("reason").and_then(Value::as_str).unwrap_or("closed")),
        Err(e) => format!("Couldn't reach Mercury: {e}"),
    }
}

/// Did the user say yes (or no) out loud since the approval question?
/// Only their transcribed speech counts; the model's own reading doesn't.
pub fn spoken_verdict(said: &[(Instant, String)], since: Instant) -> Option<bool> {
    for (at, text) in said.iter().rev() {
        if *at < since { break; }
        let t = format!(" {} ", text.to_lowercase().replace(|c: char| !c.is_alphanumeric() && !c.is_whitespace() && (c as u32) < 128, " "));
        const NO: &[&str] = &[" no ", " nope ", " don't ", " dont ", " do not ", " cancel ", " stop ", " wait ", " nahi ", " nahin ", " mat ", "नहीं", "मत", "نہیں"];
        const YES: &[&str] = &[" yes ", " yeah ", " yep ", " yup ", " sure ", " ok ", " okay ", " go ahead ", " do it ", " approve", " confirm", " please do ", " haan ", " han ", " ha ji ", " ji ", " theek ", " thik ", " kar do ", " karo ", "हाँ", "हां", "ठीक", "कर दो", "ہاں", "جی", "ٹھیک"];
        if NO.iter().any(|w| t.contains(w)) { return Some(false); }
        if YES.iter().any(|w| t.contains(w)) { return Some(true); }
    }
    None
}

/// Hand Mercury's answer to the voice model and have it speak.
fn deliver(send_q: &mpsc::UnboundedSender<Value>, ready: &mut VecDeque<(String, String)>, responding: &mut bool) {
    if let Some((fc_id, answer)) = ready.pop_front() {
        let _ = send_q.send(json!({ "type": "conversation.item.create", "item": { "type": "function_call_output", "call_id": fc_id, "output": answer } }));
        let _ = send_q.send(json!({ "type": "response.create" }));
        *responding = true;
    }
}

/// Turn the voice provider's close reason into something the owner can act on.
fn explain_close(reason: &str) -> String {
    let r = reason.to_ascii_lowercase();
    if r.contains("insufficient_quota") || r.contains("credit_balance") || r.contains("billing") {
        "your OpenAI account is out of credit. Add credit at platform.openai.com → Settings → Billing, then call again".into()
    } else if r.contains("invalid_api_key") || r.contains("unauthorized") || r.contains("401") {
        "OpenAI rejected the API key. Check the OpenAI provider in Mercury's dashboard (Providers)".into()
    } else if r.contains("model_not_found") || r.contains("does not exist") || r.contains("access") {
        format!("this OpenAI account can't use the realtime voice model ({reason}). Try another voiceModel setting")
    } else if r.contains("rate_limit") {
        "OpenAI is rate-limiting this account right now. Try again in a minute".into()
    } else if reason.is_empty() {
        "the voice model closed the session".into()
    } else {
        format!("the voice model closed the session ({reason})")
    }
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
    fn only_the_users_own_yes_counts() {
        let asked = Instant::now();
        let after = asked + Duration::from_millis(10);
        assert_eq!(spoken_verdict(&[(after, "Yes, go ahead".into())], asked), Some(true));
        assert_eq!(spoken_verdict(&[(after, "haan kar do".into())], asked), Some(true));
        assert_eq!(spoken_verdict(&[(after, "No, don't do that".into())], asked), Some(false));
        assert_eq!(spoken_verdict(&[(after, "what did you say?".into())], asked), None);
        // Words from before the question don't count.
        assert_eq!(spoken_verdict(&[(asked - Duration::from_secs(5), "yes".into())], asked), None);
    }

    #[test]
    fn close_reasons_are_explained() {
        assert!(explain_close("insufficient_quota.credit_balance_exhausted").contains("out of credit"));
        assert!(explain_close("").contains("closed"));
    }

    #[test]
    fn pcm_round_trip() {
        let s = vec![0i16, 1, -1, i16::MAX, i16::MIN];
        assert_eq!(b64_to_pcm(&pcm_to_b64(&s)), s);
    }
}
