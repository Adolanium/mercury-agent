# Optimus

Mercury uses your computer like a person: it sees the screen, moves the mouse, types, and opens apps, on macOS, Windows and Linux.

## Setup

```
mercury plugins install optimus
```

Setup asks one question: **Let Optimus control this computer?** Nothing works until you say yes (change it later in `/plugins optimus`).

- **macOS:** Optimus builds `Optimus.app` in its data folder and signs it with a certificate made on your Mac (no Apple account involved), then asks for two permissions in System Settings → Privacy & Security: **Accessibility** (mouse and keyboard) and **Screen Recording** (seeing the screen). The permissions survive updates. macOS asks you to confirm Screen Recording again about once a month.
- **Windows:** nothing to grant. Windows running as administrator (Task Manager, installers) can't be controlled yet.
- **Linux:** works fully on X11. On Wayland, screenshots go through the desktop's screen-sharing prompt and input reaches only X11 apps for now.

## What it can do

| Tool | What it does |
| --- | --- |
| `look` | Screenshot of the display the mouse is on (or display N), with an optional zoom |
| `act` | Click, double-click, right-click, drag, type, key combos, scroll, wait; returns a fresh screenshot |
| `act_consequential` | The same, for steps that submit, send, pay, delete, install or change settings: you approve first |
| `open` | Open an app by name, a URL, or a file |
| `windows` | List open windows |
| `permissions` | Check (and request) the OS permissions |

## Safety

- Off until you allow it in setup.
- Anything that commits something goes through Mercury's approval prompt.
- Move the mouse while Optimus is working and it stops, handing control back.
- It never types passwords, card numbers or 2FA codes: it asks you to.
- Screenshots go to the model for the current step only; they are not saved in chat history or logs.

## Build

```
cd plugins/optimus/companion && cargo build --release
node plugins/optimus/package.mjs companion/target/release/mercury-optimus darwin-arm64 dist
```

Linux needs `libxcb1-dev libxrandr-dev libdbus-1-dev libpipewire-0.3-dev libwayland-dev libegl-dev libgbm-dev clang` to build.
