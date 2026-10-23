# Release v1.4.0

## ☿ Mercury Agent v1.4.0 — Mercury Plugins

Mercury gets plugins. Install what you need with `/plugins install <id>`: each plugin runs in its own process, comes from a checksum-verified catalog, and asks for exactly the access it needs. Two official plugins ship today on macOS, Windows and Linux:

- **WhatsApp**: chat with Mercury, and talk to it on voice calls. It can call you, or listen to you on the go.
- **Optimus**: Mercury uses your computer. It sees the screen, moves, scrolls and types like a person, talks back, and stops the moment you say "stop".

The first stable release since 1.3.8. It also carries the 1.3.9 hotfix below, which only shipped on the dev channel.

### Plugins (#203)
- **Optional plugins.** `/plugins install|enable|disable|update|rollback|uninstall`, from a checksum-verified catalog at mercuryagent.sh. Plugins run out of process, so a crashing plugin can't take Mercury down, and they declare their network hosts, secrets and permissions up front.
- **Plugin API 1.2.** Plugins can return images to the model (kept out of chat history), request desktop access (`permissions.desktop`), and add `whatsapp` or `desktop` channels.
- **Plugins use Mercury's own providers.** You set a key once; plugins borrow it. A missing optional key is explained once, with what it turns off.
- **Guided setup and a flatter `/plugins <id>` menu.** Settings are listed on the menu itself, yes/no options say what each answer does, and the follow-up settings appear right after you save. No dead ends.
- Installing a plugin into a running Mercury now starts it immediately (it used to wait for a restart).

### WhatsApp plugin 0.1.1 (#202)
- Chat with Mercury on WhatsApp from a spare number, as a linked device.
- **Voice calls in both directions.** Mercury can call you ("call me at 9pm", "call me when it's done"), keeps you posted while it works, takes approvals by voice or in the chat, and sends links, photos and documents mid-call.
- Choose the voice engine (OpenAI by default, Gemini, Grok, ElevenLabs, Azure, Qwen, or your own Mercury model), access levels (General / Extended), and link or unlink from the dashboard.

### Optimus plugin 0.4.7 (new)
- **Mercury uses your computer.** It looks at the screen, then moves the pointer, scrolls and types the way a person does, with a "Mercury is driving" overlay while it has control. macOS, Windows and Linux; no developer certificates needed.
- **Talk to it.** A talk key starts listening mode with spoken replies, a mute key stops listening without stopping the work, and saying "stop" halts every action at once. Silence ends a session, so nothing is captured or spent while you're away.
- **Honest about results.** Optimus checks the screen before it reports something as done, and failed actions are reported as failed.
- Consequential actions ask first; Mercury declines to play or automate games that use anti-cheat (Vanguard, Easy Anti-Cheat, BattlEye), since automated input there can get your account banned. The TUI status bar shows when Optimus is listening or working, and a soft tick-tock plays while it works.
- Voice settings are shared with WhatsApp.

### Also new
- **Built-in `web_search`.**
- **Mercury reads photos and PDFs, and listens to voice notes, from chat.**
- Mercury always knows it comes from Cosmic Stack.
- Web dashboard: plain-language model names, renaming, a reasoning picker, every local Ollama model, ChatGPT Plus/Pro plan models.

### Fixed
- **The desktop channel no longer loops broadcasts.** One failing alert used to fan out into hundreds of WhatsApp messages; repeated alerts are now sent once.
- ChatGPT OAuth turns no longer fail after a tool call.
- Long messages no longer fail memory search ("Expression tree is too large").
- New dashboard chats no longer land in the previous conversation; dashboard permission prompts render and resolve.
- Plugin tar calls work with GNU tar on Windows.
- **The web dashboard works on the Windows standalone binary.** Mercury looked for its `web/` folder inside the binary's virtual filesystem, because it only recognised Bun's macOS/Linux marker (`$bunfs`) and not Windows' (`~BUN`), so the dashboard reported "web UI not found". Found and fixed by @farena-ai in #189; the same check is now shared by the login page and the memory-graph fallback.

### Upgrade

**npm:**
```
npm install -g @cosmicstack/mercury-agent@1.4.0
mercury restart
```

**Standalone binary:** `mercury upgrade`, or re-run the one-line installer from mercuryagent.sh.

Then try a plugin:
```
/plugins install optimus
/plugins install whatsapp
```

No config migrations. Plugins are opt-in.

Docs: https://mercuryagent.sh/docs/integrations/optimus · https://mercuryagent.sh/docs/integrations/whatsapp · https://mercuryagent.sh/docs/releases/1.4.0

**Full Changelog**: https://github.com/cosmicstack-labs/mercury-agent/compare/v1.3.8...v1.4.0
