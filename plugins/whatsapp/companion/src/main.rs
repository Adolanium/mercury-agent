//! mercury-wa: the WhatsApp side of the Mercury WhatsApp plugin.
//!
//! Mercury starts this program and talks to it over stdio, one JSON-RPC 2.0
//! message per line: MCP (`initialize`, `tools/list`, `ping`) plus the
//! Mercury channel extension (plugin API 1.1). See
//! website/docs/reference/plugins.mdx → "Chat channels".
//!
//! This process only moves messages. Mercury decides who may talk to the
//! agent (owner and members), so nothing here filters senders.
//!
//! stdout is the protocol channel: logs go to stderr only.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::{Mutex, mpsc};
use whatsapp_rust::download::{DownloadLimits, MediaType};
use whatsapp_rust::media::{self, DocumentOptions, ImageOptions};
use whatsapp_rust::pair_code::PairCodeOptions;
use whatsapp_rust::prelude::*;
use whatsapp_rust::upload::UploadOptions;

const MAX_DOWNLOAD_BYTES: usize = 50 * 1024 * 1024;

/// Writes protocol lines to stdout, in order, from any task.
#[derive(Clone)]
struct Out(mpsc::UnboundedSender<Value>);

impl Out {
    fn notify(&self, method: &str, params: Value) {
        let _ = self.0.send(json!({ "jsonrpc": "2.0", "method": method, "params": params }));
    }
    fn reply(&self, id: &Value, result: Value) {
        let _ = self.0.send(json!({ "jsonrpc": "2.0", "id": id, "result": result }));
    }
    fn error(&self, id: &Value, code: i64, message: impl Into<String>) {
        let _ = self.0.send(json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message.into() } }));
    }
    fn status(&self, state: &str, extra: Value) {
        let mut params = json!({ "state": state });
        if let (Some(p), Some(e)) = (params.as_object_mut(), extra.as_object()) {
            for (k, v) in e {
                p.insert(k.clone(), v.clone());
            }
        }
        self.notify("mercury/channel/status", params);
    }
}

struct State {
    data_dir: PathBuf,
    out: Out,
    bot: Mutex<Option<BotHandle>>,
    client: Mutex<Option<Arc<Client>>>,
}

fn log(msg: impl AsRef<str>) {
    eprintln!("[mercury-wa] {}", msg.as_ref());
}

fn db_path(dir: &Path) -> PathBuf {
    dir.join("whatsapp.db")
}

/// The user part of a phone-number JID ("15551234567@s.whatsapp.net" → "15551234567").
fn phone_of(jid: &Jid) -> Option<String> {
    let s = jid.to_string();
    let (user, server) = s.split_once('@')?;
    if server != "s.whatsapp.net" {
        return None;
    }
    Some(user.split(':').next().unwrap_or(user).to_string())
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let data_dir = PathBuf::from(std::env::var("MERCURY_PLUGIN_DATA_DIR").unwrap_or_else(|_| ".".into()));
    std::fs::create_dir_all(data_dir.join("media"))?;

    let (tx, mut rx) = mpsc::unbounded_channel::<Value>();
    tokio::spawn(async move {
        let mut stdout = tokio::io::stdout();
        while let Some(v) = rx.recv().await {
            let mut line = v.to_string();
            line.push('\n');
            if stdout.write_all(line.as_bytes()).await.is_err() {
                break;
            }
            let _ = stdout.flush().await;
        }
    });
    let out = Out(tx);
    let state = Arc::new(State { data_dir, out: out.clone(), bot: Mutex::new(None), client: Mutex::new(None) });

    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    while let Some(line) = lines.next_line().await? {
        let Ok(msg) = serde_json::from_str::<Value>(&line) else { continue };
        let st = state.clone();
        tokio::spawn(async move { handle(st, msg).await });
    }
    // Mercury closed stdin: we are being stopped.
    if let Some(bot) = state.bot.lock().await.take() {
        let _ = tokio::time::timeout(Duration::from_secs(3), bot.shutdown()).await;
    }
    Ok(())
}

async fn handle(st: Arc<State>, msg: Value) {
    let method = msg.get("method").and_then(Value::as_str).unwrap_or("");
    let params = msg.get("params").cloned().unwrap_or(Value::Null);
    let Some(id) = msg.get("id").cloned() else {
        // Notifications from Mercury.
        if method == "notifications/initialized" {
            if db_path(&st.data_dir).exists() {
                // Linked before: reconnect with the saved session.
                if let Err(e) = start_bot(st.clone(), None).await {
                    st.out.status("error", json!({ "detail": format!("couldn't start: {e}") }));
                }
            } else {
                st.out.status("needs-pairing", json!({}));
            }
        }
        return;
    };
    let out = st.out.clone();
    let result: Result<Value, String> = match method {
        "initialize" => Ok(json!({
            "protocolVersion": "2025-06-18",
            "capabilities": { "tools": {} },
            "serverInfo": { "name": "mercury-wa", "version": env!("CARGO_PKG_VERSION") },
        })),
        "ping" => Ok(json!({})),
        "tools/list" => Ok(json!({ "tools": [] })),
        "mercury/channel/pair" => pair(st.clone(), &params).await,
        "mercury/channel/unlink" => unlink(st.clone()).await,
        "mercury/channel/send" => send_text(st.clone(), &params).await,
        "mercury/channel/sendFile" => send_file(st.clone(), &params).await,
        "mercury/channel/typing" => typing(st.clone(), &params).await,
        _ => {
            out.error(&id, -32601, format!("Method not found: {method}"));
            return;
        }
    };
    match result {
        Ok(v) => out.reply(&id, v),
        Err(e) => out.error(&id, -32000, e),
    }
}

async fn client(st: &State) -> Result<Arc<Client>, String> {
    st.client.lock().await.clone().ok_or_else(|| "WhatsApp is not linked yet. Pair first.".to_string())
}

fn jid_param(params: &Value) -> Result<Jid, String> {
    let s = params.get("chatId").and_then(Value::as_str).ok_or("chatId is required")?;
    s.parse::<Jid>().map_err(|e| format!("bad chatId {s}: {e}"))
}

async fn pair(st: Arc<State>, params: &Value) -> Result<Value, String> {
    let phone = params.get("phone").and_then(Value::as_str).map(|p| p.chars().filter(char::is_ascii_digit).collect::<String>());
    let method = params.get("method").and_then(Value::as_str).unwrap_or("qr");
    if method == "code" && phone.as_deref().unwrap_or("").len() < 6 {
        return Err("a pairing code needs the phone number being linked".into());
    }
    // Already connected?
    if let Some(c) = st.client.lock().await.clone() {
        if c.is_logged_in() {
            st.out.status("connected", json!({ "account": c.pn().and_then(|j| phone_of(&j)) }));
            return Ok(json!({}));
        }
    }
    // Restart linking from scratch so the requested method takes effect.
    if let Some(bot) = st.bot.lock().await.take() {
        let _ = tokio::time::timeout(Duration::from_secs(3), bot.shutdown()).await;
    }
    *st.client.lock().await = None;
    remove_session(&st.data_dir);
    start_bot(st.clone(), if method == "code" { phone } else { None }).await.map_err(|e| e.to_string())?;
    Ok(json!({}))
}

fn remove_session(dir: &Path) {
    for suffix in ["", "-wal", "-shm", "-journal"] {
        let _ = std::fs::remove_file(dir.join(format!("whatsapp.db{suffix}")));
    }
}

async fn unlink(st: Arc<State>) -> Result<Value, String> {
    let c = st.client.lock().await.take();
    if let Some(c) = c {
        let _ = tokio::time::timeout(Duration::from_secs(10), c.logout()).await;
    }
    if let Some(bot) = st.bot.lock().await.take() {
        let _ = tokio::time::timeout(Duration::from_secs(3), bot.shutdown()).await;
    }
    remove_session(&st.data_dir);
    st.out.status("logged-out", json!({ "detail": "unlinked by the owner" }));
    Ok(json!({}))
}

async fn send_text(st: Arc<State>, params: &Value) -> Result<Value, String> {
    let c = client(&st).await?;
    let to = jid_param(params)?;
    let text = params.get("text").and_then(Value::as_str).ok_or("text is required")?;
    let sent = c.send_text(to, text).await.map_err(|e| e.to_string())?;
    Ok(json!({ "id": sent.message_id.to_string() }))
}

async fn send_file(st: Arc<State>, params: &Value) -> Result<Value, String> {
    let c = client(&st).await?;
    let to = jid_param(params)?;
    let path = PathBuf::from(params.get("path").and_then(Value::as_str).ok_or("path is required")?);
    let caption = params.get("caption").and_then(Value::as_str).map(str::to_string);
    let bytes = tokio::fs::read(&path).await.map_err(|e| format!("can't read {}: {e}", path.display()))?;
    let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| "file".into());
    let mime = mime_of(&name);
    let is_image = mime.starts_with("image/") && mime != "image/svg+xml";
    let msg = if is_image {
        let up = c.upload(bytes, MediaType::Image, UploadOptions::default()).await.map_err(|e| e.to_string())?;
        let mut opts = ImageOptions::default().with_mimetype(mime);
        if let Some(cap) = caption {
            opts = opts.with_caption(cap);
        }
        media::image_message(up, opts)
    } else {
        let up = c.upload(bytes, MediaType::Document, UploadOptions::default()).await.map_err(|e| e.to_string())?;
        let mut opts = DocumentOptions::default().with_file_name(name).with_mimetype(mime);
        if let Some(cap) = caption {
            opts = opts.with_caption(cap);
        }
        media::document_message(up, opts)
    };
    let sent = c.send_message(to, msg).await.map_err(|e| e.to_string())?;
    Ok(json!({ "id": sent.message_id.to_string() }))
}

async fn typing(st: Arc<State>, params: &Value) -> Result<Value, String> {
    let c = client(&st).await?;
    let to = jid_param(params)?;
    let on = params.get("on").and_then(Value::as_bool).unwrap_or(true);
    let r = if on { c.chatstate().send_composing(&to).await } else { c.chatstate().send_paused(&to).await };
    r.map_err(|e| e.to_string())?;
    Ok(json!({}))
}

fn mime_of(name: &str) -> String {
    let ext = name.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "pdf" => "application/pdf",
        "txt" | "md" | "log" => "text/plain",
        "csv" => "text/csv",
        "json" => "application/json",
        "html" => "text/html",
        "zip" => "application/zip",
        "doc" => "application/msword",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "mp3" => "audio/mpeg",
        "ogg" | "opus" => "audio/ogg",
        "mp4" => "video/mp4",
        _ => "application/octet-stream",
    }
    .to_string()
}

async fn start_bot(st: Arc<State>, phone: Option<String>) -> anyhow::Result<()> {
    let db = db_path(&st.data_dir);
    let store = SqliteStore::open(&db.to_string_lossy()).await?;
    st.out.status("starting", json!({}));

    let (o1, o2, o3, o4, o5) = (st.out.clone(), st.out.clone(), st.out.clone(), st.out.clone(), st.out.clone());
    let st_conn = st.clone();
    let st_msg = st.clone();
    let mut builder = Bot::builder()
        .with_backend(store)
        .on_qr_code(move |code, _ttl| {
            let o = o1.clone();
            async move { o.status("pairing", json!({ "qr": code })) }
        })
        .on_pair_code(move |code, _ttl| {
            let o = o2.clone();
            async move { o.status("pairing", json!({ "pairCode": code })) }
        })
        .on_connected(move |client| {
            let st = st_conn.clone();
            async move {
                let account = client.pn().and_then(|j| phone_of(&j));
                *st.client.lock().await = Some(client);
                st.out.status("connected", json!({ "account": account }));
            }
        })
        .on_logged_out(move |lo| {
            let o = o3.clone();
            async move { o.status("logged-out", json!({ "detail": format!("{:?}", lo.reason) })) }
        })
        .on_event_for(&[EventKind::Disconnected, EventKind::TemporaryBan, EventKind::StreamReplaced, EventKind::ClientOutdated], move |ev, _client| {
            let o = o4.clone();
            async move {
                match &*ev {
                    Event::TemporaryBan(b) => o.status("error", json!({ "detail": format!("WhatsApp temporarily banned this number: {b:?}") })),
                    Event::StreamReplaced(_) => o.status("disconnected", json!({ "detail": "another WhatsApp Web session took over this link" })),
                    Event::ClientOutdated(_) => o.status("error", json!({ "detail": "WhatsApp says this client is outdated: update the plugin" })),
                    _ => o.status("disconnected", json!({ "detail": "connection lost, reconnecting" })),
                }
            }
        })
        .on_message(move |ctx| {
            let st = st_msg.clone();
            let o = o5.clone();
            async move { on_message(st, o, ctx).await }
        });
    if let Some(phone) = phone {
        builder = builder.with_pair_code(PairCodeOptions { phone_number: phone, ..Default::default() });
    }
    let bot = builder.build().await?;
    let handle = bot.spawn();
    *st.client.lock().await = None;
    *st.bot.lock().await = Some(handle);
    Ok(())
}

async fn on_message(st: Arc<State>, out: Out, ctx: MessageContext) {
    let src = &ctx.info.source;
    if src.is_from_me {
        return;
    }
    let chat = src.chat.to_string();
    let sender_phone = phone_of(&src.sender).or_else(|| src.sender_alt.as_ref().and_then(phone_of));
    let mut text = ctx.message.text_content().map(str::to_string).unwrap_or_default();
    let mut attachments = Vec::new();

    let base = ctx.message.get_base_message();
    let dir = st.data_dir.join("media");
    let id = ctx.info.id.to_string();
    let safe_id: String = id.chars().filter(|c| c.is_ascii_alphanumeric()).take(40).collect();

    if let Some(m) = base.image_message.as_option() {
        if text.is_empty() {
            text = m.caption.clone().unwrap_or_default();
        }
        let r = ctx.client.download(m, DownloadLimits::default()).await.map_err(|e| e.to_string());
        save(&dir, "image", &safe_id, "jpg", r, &mut attachments).await;
    }
    if let Some(m) = base.document_message.as_option() {
        if text.is_empty() {
            text = m.caption.clone().unwrap_or_default();
        }
        let ext = m.file_name.as_deref().and_then(|n| n.rsplit('.').next()).filter(|e| e.len() <= 8 && e.chars().all(|c| c.is_ascii_alphanumeric())).unwrap_or("bin").to_string();
        let r = ctx.client.download(m, DownloadLimits::default()).await.map_err(|e| e.to_string());
        save(&dir, "document", &safe_id, &ext, r, &mut attachments).await;
    }
    if let Some(m) = base.audio_message.as_option() {
        let kind = if m.ptt == Some(true) { "voice" } else { "audio" };
        let r = ctx.client.download(m, DownloadLimits::default()).await.map_err(|e| e.to_string());
        save(&dir, kind, &safe_id, "ogg", r, &mut attachments).await;
    }

    if text.is_empty() && attachments.is_empty() {
        return;
    }
    let _ = ctx.client.mark_as_read(&src.chat, if src.is_group { Some(&src.sender) } else { None }, &[id.as_str()]).await;
    out.notify("mercury/channel/message", json!({
        "id": id,
        "chatId": chat,
        "senderId": src.sender.to_string(),
        "senderPhone": sender_phone,
        "senderName": ctx.info.push_name.to_string(),
        "isGroup": src.is_group,
        "fromMe": false,
        "text": text,
        "attachments": attachments,
        "timestamp": ctx.info.timestamp.timestamp_millis(),
    }));
}

async fn save(dir: &Path, kind: &str, id: &str, ext: &str, bytes: Result<Vec<u8>, String>, attachments: &mut Vec<Value>) {
    match bytes {
        Ok(b) if b.len() <= MAX_DOWNLOAD_BYTES => {
            let path = dir.join(format!("{kind}-{id}.{ext}"));
            match tokio::fs::write(&path, &b).await {
                Ok(()) => attachments.push(json!({ "kind": kind, "path": path.to_string_lossy() })),
                Err(e) => log(format!("couldn't save attachment: {e}")),
            }
        }
        Ok(_) => log("skipped an attachment over 50 MB"),
        Err(e) => log(format!("attachment download failed: {e}")),
    }
}
