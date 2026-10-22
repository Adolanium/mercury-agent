//! mercury-optimus: full computer control for Mercury.
//!
//! Mercury starts this program and talks to it over stdio, one JSON-RPC 2.0
//! message per line (MCP: initialize, tools/list, tools/call, ping). Tools
//! return text plus a screenshot as an MCP image, which Mercury (plugin API
//! 1.2) hands to the model as an image.
//!
//! On macOS the work happens in Optimus.app (see mac.rs) so the OS
//! permissions belong to Optimus; elsewhere it happens here.
//!
//! Nothing runs until the owner turns on "Let Optimus control this
//! computer" in the plugin's setup. Steps that commit something go through
//! act_consequential, which Mercury asks the owner to approve.
//!
//! stdout is the protocol channel: logs go to stderr only.

#[cfg(target_os = "macos")]
mod mac;
mod ops;

use std::io::{BufRead, Write};
use std::sync::{Arc, Mutex};

use serde_json::{Value, json};

/// Where operations run: Optimus.app on macOS, this process elsewhere.
struct Backend {
    #[cfg(target_os = "macos")]
    agent: Option<mac::Agent>,
    #[cfg(not(target_os = "macos"))]
    ops: ops::Ops,
}

impl Backend {
    fn new() -> Self {
        Backend {
            #[cfg(target_os = "macos")]
            agent: None,
            #[cfg(not(target_os = "macos"))]
            ops: ops::Ops::new(),
        }
    }

    fn run(&mut self, op: &str, args: &Value) -> Result<Value, String> {
        #[cfg(target_os = "macos")]
        {
            if self.agent.is_none() {
                self.agent = Some(mac::start_agent()?);
            }
            let r = self.agent.as_mut().unwrap().call(op, args);
            if r.as_ref().err().is_some_and(|e| e.contains("went away")) {
                // Optimus.app quit (e.g. macOS restarted it after a permission change): once more.
                self.agent = Some(mac::start_agent()?);
                return self.agent.as_mut().unwrap().call(op, args);
            }
            r
        }
        #[cfg(not(target_os = "macos"))]
        {
            self.ops.run(op, args)
        }
    }
}

fn allowed() -> bool {
    std::env::var("MERCURY_PLUGIN_SETTINGS")
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| v.get("allowControl").and_then(Value::as_bool))
        .unwrap_or(false)
}

const NOT_ALLOWED: &str = "Optimus is off: the owner hasn't allowed it to control this computer yet. \
Ask them to run /plugins optimus and turn on \"Let Optimus control this computer\".";

fn action_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "actions": {
                "type": "array",
                "minItems": 1,
                "maxItems": 40,
                "description": "Done in order. Coordinates are pixels in the latest screenshot.",
                "items": {
                    "type": "object",
                    "properties": {
                        "type": { "type": "string", "enum": ["click", "double_click", "triple_click", "right_click", "middle_click", "move", "drag", "mouse_down", "mouse_up", "type", "key", "scroll", "wait"] },
                        "x": { "type": "number" },
                        "y": { "type": "number" },
                        "to_x": { "type": "number", "description": "drag: end x" },
                        "to_y": { "type": "number", "description": "drag: end y" },
                        "text": { "type": "string", "description": "type: the text (with x/y, clicks there first)" },
                        "keys": { "type": "string", "description": "key: one key or a combo, e.g. \"enter\", \"cmd+t\", \"ctrl+shift+esc\"" },
                        "modifiers": { "type": "string", "description": "click: keys held while clicking, e.g. \"cmd\" or \"shift\"" },
                        "repeat": { "type": "integer", "minimum": 1, "maximum": 50 },
                        "direction": { "type": "string", "enum": ["up", "down", "left", "right"] },
                        "amount": { "type": "integer", "minimum": 1, "maximum": 30, "description": "scroll: notches (default 3)" },
                        "seconds": { "type": "number", "minimum": 0, "maximum": 10, "description": "wait: seconds" }
                    },
                    "required": ["type"]
                }
            },
            "screenshot": { "type": "boolean", "description": "Return a screenshot afterwards (default true)." },
            "settle_ms": { "type": "integer", "minimum": 0, "maximum": 5000, "description": "Wait before that screenshot (default 500)." }
        },
        "required": ["actions"]
    })
}

const TOOL_DESCRIPTIONS: [(&str, &str); 6] = [
    ("look", "See the screen: a screenshot of the display the mouse is on (or `display` N), with the active window. Use `zoom` [x0,y0,x1,y1] for a closer look at part of the last screenshot (coordinates stay in the full screenshot)."),
    ("act", "Use the mouse and keyboard like a person: click, type, press keys, scroll, drag. Returns a fresh screenshot. Only for ordinary, reversible steps. Anything that submits, sends, posts, pays, buys, deletes, installs or changes settings must go through act_consequential instead. Never type passwords, card numbers or 2FA codes: ask the owner to do that part."),
    ("act_consequential", "Same as act, for the step that commits something: submit a form, send a message or email, post, pay or buy, delete, install, change a setting. The owner approves it first, so say what it will do."),
    ("open", "Open an app by name (\"Safari\", \"Blender\", \"Notepad\"), a URL, or a file/folder path. Faster and more reliable than clicking through menus."),
    ("windows", "List open windows (app and title), front first."),
    ("permissions", "Check what the OS lets Optimus do (macOS: Accessibility and Screen Recording). With request=true, shows the system prompts and opens the right Settings page."),
];

fn tools() -> Value {
    let schema = |name: &str| match name {
        "look" => json!({
            "type": "object",
            "properties": {
                "display": { "type": "integer", "minimum": 1 },
                "zoom": { "type": "array", "items": { "type": "number" }, "minItems": 4, "maxItems": 4 }
            }
        }),
        "act" | "act_consequential" => action_schema(),
        "open" => json!({ "type": "object", "properties": { "target": { "type": "string" } }, "required": ["target"] }),
        "permissions" => json!({ "type": "object", "properties": { "request": { "type": "boolean" } } }),
        _ => json!({ "type": "object", "properties": {} }),
    };
    Value::Array(
        TOOL_DESCRIPTIONS
            .iter()
            .map(|(name, description)| json!({ "name": name, "description": description, "inputSchema": schema(name) }))
            .collect(),
    )
}

fn call(backend: &Mutex<Backend>, name: &str, args: &Value) -> Value {
    if name != "permissions" && !allowed() {
        return json!({ "content": [{ "type": "text", "text": NOT_ALLOWED }], "isError": true });
    }
    let op = match name {
        "act_consequential" => "act",
        other => other,
    };
    let result = backend.lock().unwrap_or_else(|e| e.into_inner()).run(op, args);
    match result {
        Ok(v) => {
            let mut content = vec![json!({ "type": "text", "text": v["text"].as_str().unwrap_or("Done.") })];
            if let (Some(data), Some(mime)) = (v["image"]["data"].as_str(), v["image"]["mimeType"].as_str()) {
                content.push(json!({ "type": "image", "data": data, "mimeType": mime }));
            }
            json!({ "content": content })
        }
        Err(e) => json!({ "content": [{ "type": "text", "text": e }], "isError": true }),
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) == Some("agent") {
        #[cfg(target_os = "macos")]
        {
            let socket = args.iter().position(|a| a == "--socket").and_then(|i| args.get(i + 1)).expect("--socket <path>");
            mac::agent_main(std::path::Path::new(socket));
        }
        #[cfg(not(target_os = "macos"))]
        {
            eprintln!("agent mode is macOS-only");
            std::process::exit(2);
        }
    }

    let out = Arc::new(Mutex::new(std::io::stdout()));
    let send = {
        let out = out.clone();
        move |v: Value| {
            let mut o = out.lock().unwrap_or_else(|e| e.into_inner());
            let _ = writeln!(o, "{v}");
            let _ = o.flush();
        }
    };
    let backend = Arc::new(Mutex::new(Backend::new()));

    // With consent already given, get Optimus.app running (and its permission
    // prompts showing, if any are missing) before the first request.
    if allowed() {
        let b = backend.clone();
        std::thread::spawn(move || {
            let report = b.lock().unwrap_or_else(|e| e.into_inner()).run("permissions", &json!({ "request": true }));
            match report {
                Ok(r) => eprintln!("optimus: {}", r["text"].as_str().unwrap_or("").replace('\n', " | ")),
                Err(e) => eprintln!("optimus: {e}"),
            }
        });
    }

    for line in std::io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        let Ok(msg) = serde_json::from_str::<Value>(&line) else { continue };
        let Some(id) = msg.get("id").cloned() else { continue }; // notifications: nothing to do
        let method = msg["method"].as_str().unwrap_or("").to_string();
        let params = msg.get("params").cloned().unwrap_or(json!({}));
        match method.as_str() {
            "initialize" => send(json!({ "jsonrpc": "2.0", "id": id, "result": {
                "protocolVersion": params["protocolVersion"].as_str().unwrap_or("2025-06-18"),
                "capabilities": { "tools": {} },
                "serverInfo": { "name": "mercury-optimus", "version": env!("CARGO_PKG_VERSION") }
            }})),
            "ping" => send(json!({ "jsonrpc": "2.0", "id": id, "result": {} })),
            "tools/list" => send(json!({ "jsonrpc": "2.0", "id": id, "result": { "tools": tools() } })),
            "tools/call" => {
                // Off the reader thread, so pings are answered during long actions.
                let (backend, send) = (backend.clone(), send.clone());
                std::thread::spawn(move || {
                    let name = params["name"].as_str().unwrap_or("");
                    let result = call(&backend, name, &params["arguments"]);
                    send(json!({ "jsonrpc": "2.0", "id": id, "result": result }));
                });
            }
            _ => send(json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32601, "message": format!("unknown method {method}") } })),
        }
    }
}
