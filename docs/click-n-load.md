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
   cargo install --root ~/.local --git https://github.com/firsttris/haul haul-cnl
   haul-cnl --server http://server.local:8080 --token <TOKEN>
   ```

   Instead of the flags, `HAUL_SERVER` and `HAUL_TOKEN` work too. `--listen` or `HAUL_CNL_LISTEN`
   changes the address, `127.0.0.1:9666` by default.

3. To start it with your session, use the systemd user unit
   [`crates/haul-cnl/haul-cnl.service`](https://github.com/firsttris/haul/blob/main/crates/haul-cnl/haul-cnl.service).
   It runs `~/.local/bin/haul-cnl`, which is where `--root ~/.local` above installs it, and reads
   server and token from `~/.config/haul/cnl.env`:

   ```bash
   install -Dm644 haul-cnl.service ~/.config/systemd/user/haul-cnl.service
   mkdir -p ~/.config/haul
   printf 'HAUL_SERVER=http://server.local:8080\nHAUL_TOKEN=<TOKEN>\n' > ~/.config/haul/cnl.env
   chmod 600 ~/.config/haul/cnl.env
   systemctl --user enable --now haul-cnl
   ```

Turn off *Handle Click'n'Load buttons* in the extension while `haul-cnl` runs, or the extension
answers first.

**Just testing?** An SSH tunnel does the same: `ssh -N -L 9666:localhost:9666 server.local`
(the compose file publishes port 9666 on the server's loopback for this).

## What happens with the links

Received links land in the **link grabber** with their source page and never start by themselves.
The CNL2 `jk` snippet runs in its own QuickJS instance without host functions, limited to 16 MiB
of memory and 2 seconds. Always bind port 9666 to `127.0.0.1` only.

## The button does nothing?

1. **Settings → Test Click'n'Load in this browser** tells whether the extension, Haul or `haul-cnl`
   handles Click'n'Load on your computer. With the extension, see its
   [troubleshooting](browser-extension.md#troubleshooting).
2. Without the extension, Chrome asks for access to the local network on some sites; allow it.
   **Brave** blocks sites from reaching `localhost` by default. Allow it in the address bar prompt or
   under `brave://settings/content/localhostAccess`. The test button in Haul cannot show this, because
   Haul's own page is allowed.
3. Haul logs every request as `Click'n'Load request …`, `haul-cnl` as `POST /flash/add von <origin>`. Nothing in the log means the
   browser does not reach the port.
4. The links are in the **link grabber**, not in the downloads.
