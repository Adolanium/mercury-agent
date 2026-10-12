#!/usr/bin/env python3
"""First-run wizard smoke under a pseudo-terminal.

Drives a Mercury binary (or `node dist/index.js`) through the identity
questions to the first arrow-key menu and asserts the process is STILL
ALIVE there, then picks "Offline / BYOK" and expects the provider question.

Regression guard for 1.3.1–1.3.6, where the wizard exited 0 at the menu:
a deferred readline release paused stdin after the menu had taken it over.
`--version` smoke tests cannot see that; only a terminal can.

Usage: smoke-wizard-pty.py <binary> [args...]
"""
import os, pty, select, sys, tempfile, time

def main() -> int:
    if len(sys.argv) < 2:
        print("usage: smoke-wizard-pty.py <binary> [args...]", file=sys.stderr)
        return 2
    binary, args = sys.argv[1], sys.argv[2:]
    home = tempfile.mkdtemp(prefix="mercury-wizard-")
    env = dict(os.environ, MERCURY_HOME=home, TERM="xterm-256color", CI="0")
    pid, fd = pty.fork()
    if pid == 0:
        os.execvpe(binary, [binary] + args, env)
    out = bytearray()

    def pump(seconds: float) -> None:
        end = time.time() + seconds
        while time.time() < end:
            r, _, _ = select.select([fd], [], [], 0.2)
            if fd in r:
                try:
                    out.extend(os.read(fd, 65536))
                except OSError:
                    return

    def alive() -> bool:
        try:
            wpid, _ = os.waitpid(pid, os.WNOHANG)
        except ChildProcessError:
            return False
        return wpid == 0

    pump(8)
    if b"Your name" not in out:
        print("FAIL: wizard did not ask for a name\n" + out.decode("utf8", "replace")[-800:])
        return 1
    os.write(fd, b"Smoke Tester\n"); pump(1)
    os.write(fd, b"\n"); pump(5)
    text = out.decode("utf8", "replace")
    if "Choose your mode" not in text:
        print("FAIL: mode menu never rendered\n" + text[-800:])
        return 1
    if not alive():
        print("FAIL: process exited at the mode menu (the 1.3.1-1.3.6 regression)\n" + text[-800:])
        return 1
    os.write(fd, b"\x1b[B"); pump(0.5)   # down → Offline / BYOK
    os.write(fd, b"\r"); pump(5)
    text = out.decode("utf8", "replace")
    if "Choose providers" not in text:
        print("FAIL: Enter on the menu did not advance to the provider step\n" + text[-800:])
        if alive(): os.kill(pid, 9)
        return 1
    print("OK: wizard reaches the provider step under a pty; process alive throughout")
    if alive(): os.kill(pid, 9)
    return 0

if __name__ == "__main__":
    sys.exit(main())
