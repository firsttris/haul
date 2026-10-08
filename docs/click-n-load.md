# Click'n'Load

Link sites with a Click'n'Load button send the links to `127.0.0.1:9666` **on the computer with the
browser**. Haul runs on a server, so something on your desktop has to pass the links on.

## Browser extension (recommended)

The [Haul browser extension](browser-extension.md) for Chrome and Firefox takes the Click'n'Load
requests over inside the page and sends the links to Haul. Nothing else has to run on your
computer. It also adds
*Send to Haul* to the right-click menu.

## haul-cnl (for developers)

`haul-cnl` is a small forwarder for the desktop (Rust, one binary). It accepts Click'n'Load 1 and 2 on
`127.0.0.1:9666` and sends the links to Haul with an API token. It works with every browser and with
tools that talk to port 9666 directly, and helps to see what a site really sends.

1. In Haul, open **Settings → Click'n'Load from the desktop** and create an API token.
2. Install and start `haul-cnl`:

   ```bash
   cargo install --git https://github.com/firsttris/haul haul-cnl
   haul-cnl --server http://server.local:8080 --token <TOKEN>
   ```

3. To start it with your session, use the systemd user unit
   [`crates/haul-cnl/haul-cnl.service`](https://github.com/firsttris/haul/blob/main/crates/haul-cnl/haul-cnl.service).

Turn off *Handle Click'n'Load buttons* in the extension while `haul-cnl` runs, or the extension
answers first.

**Just testing?** An SSH tunnel does the same: `ssh -N -L 9666:localhost:9666 server.local`
(the compose file publishes port 9666 on the server's loopback for this).

## What happens with the links

Received links land in the **link grabber** with their source page and never start by themselves.
The CNL2 `jk` snippet runs in its own QuickJS instance without host functions, with memory and time
limits. Always bind port 9666 to `127.0.0.1` only.

## The button does nothing?

1. **Settings → Test Click'n'Load in this browser** tells whether the extension, Haul or `haul-cnl`
   handles Click'n'Load on your computer. With the extension, see its
   [troubleshooting](browser-extension.md#troubleshooting).
2. Without the extension, Chrome asks for access to the local network on some sites; allow it.
   **Brave** blocks sites from reaching `localhost` by default. Allow it in the address bar prompt or
   under `brave://settings/content/localhostAccess`. The test button in Haul cannot show this, because
   Haul's own page is allowed.
3. Haul and `haul-cnl` log every request (`Click'n'Load request …`). Nothing in the log means the
   browser does not reach the port.
4. The links are in the **link grabber**, not in the downloads.
