# WhatsApp for Mercury

Chat with Mercury on WhatsApp. Mercury runs on a **spare number** as a
linked device, the same way WhatsApp Web connects, so no WhatsApp Business
account is needed.

> ⚠️ This uses an **unofficial, reverse-engineered protocol**
> ([whatsapp-rust](https://github.com/oxidezap/whatsapp-rust)). A WhatsApp
> update can break it, and automated use can get the number restricted or
> banned. Use a spare number you can afford to lose, **not your main one**.

## Set up

1. Install it and set your own number as the owner:

   ```sh
   mercury plugins install whatsapp
   mercury plugins set whatsapp owner +15551234567
   ```

   The owner is the number you'll chat *from*. Only the owner, and any
   numbers you add to `members`, can talk to Mercury.

2. Link the spare number. Either scan a QR code in the terminal:

   ```sh
   mercury plugins pair whatsapp
   ```

   Then, on the phone with the spare number, go to WhatsApp → Settings →
   Linked devices → Link a device.

   Or get a pairing code, which also works from chat:

   ```sh
   mercury plugins pair whatsapp --code +15550001111
   ```

3. Message the spare number from your own number. Mercury answers there.

## What works

- Text both ways, with long replies split and Markdown converted to
  WhatsApp formatting.
- Files from Mercury arrive as attachments (images as photos, everything
  else as documents).
- Images, documents and voice notes you send are passed to Mercury as files.
- Approvals by reply: *1* yes, *2* no, *3* always for this chat.
- Groups are ignored unless you turn on `allowGroups`.
- If WhatsApp logs the device out, Mercury tells you on another channel.

Voice calls are coming next (#202, phase 2).

## Unlink

```sh
mercury plugins unlink whatsapp
```

Also remove "Mercury" from Linked devices on the phone if it's still listed.

## Build from source

```sh
cd plugins/whatsapp/companion
cargo build --release   # Rust 1.94+, a C compiler
node ../package.mjs target/release/mercury-wa darwin-arm64 ../dist
mercury plugins install ../dist/mercury-plugin-darwin-arm64.tgz
```
