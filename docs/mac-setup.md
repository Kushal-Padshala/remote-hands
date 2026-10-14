# Remote Hands on a Mac: setup guide

This guide is for the desktop HUD: press **Shift + Cmd + Space** anywhere on your Mac, type what you want done, press Enter.
You do not need to know how to code. Setup takes about 10 minutes, most of it waiting for downloads.

## What you need

- A Mac with macOS 13.5 or newer (Apple menu > About This Mac shows the version).
- A Google account (the agent, `agy`, signs in with it).
- Google Chrome, if you want it to work on websites.
- About 4 GB of free space (Apple's developer tools are the biggest part).

You do **not** need to install Node.js, Homebrew or anything else first.

## Install

1. Open **Terminal**: press Cmd + Space, type `Terminal`, press Enter.
2. Paste this line and press Enter:

   ```
   curl -fsSL https://raw.githubusercontent.com/Kushal-Padshala/remote-hands/main/scripts/install-mac.sh | sh
   ```

   It puts everything in a folder called `.remote-hands` in your home folder. The installer itself never asks for your Mac
   password and does not touch anything outside that folder except one line in your shell startup files (so the `rh` command is
   found).
   Run the same line again any time to update.
3. Answer the questions it asks. Here is what each part is, in the order it happens.

## What setup will ask you, and why

**Apple's "Command Line Tools"** (first, and only if your Mac does not have them). A macOS window asks you to install them.
Click **Install** and accept the terms. It is a free 1 to 3 GB download from Apple (5 to 15 minutes). Remote Hands uses it to
build two small helper programs. Setup carries on while it downloads and waits for it where it must.

**Signing in to the agent (`agy`).** Your browser opens: sign in with your Google account. When the terminal shows a box where
you can type, press **Ctrl + C** to come back to setup. It carries on by itself.

**Changing your agy settings.** Setup lists exactly what it will change and asks `Allow this? [Y/n]`. In short: agy may read
and write files and run commands without asking each time, and your home folder is trusted. This applies to agy everywhere,
including the Antigravity IDE, so read it. Your settings files are copied first (`settings.json.bak-rh`) and
`rh permissions revert` puts everything back (it removes only what Remote Hands added).

**macOS permissions.** macOS makes you switch these on yourself. Setup opens the right page of System Settings, one at a time:

1. **Screen & System Audio Recording**: lets Remote Hands see the screen. Switch on **node** and your terminal app. If `node`
   is not in the list, click **+**, press **Cmd + Shift + G**, paste the path setup printed, and choose it. macOS may offer
   "Quit & Reopen": choose Later, setup carries on.
2. **Accessibility**: lets Remote Hands click and type in apps. macOS shows a window "Remote Hands would like to control this
   computer": click **Open System Settings** and switch **Remote Hands** on.

Full Disk Access is optional for the HUD. Without it, macOS may ask "allow access to your Documents folder" now and then.

**The background HUD check.** The HUD runs as a login service, which macOS treats as a different program from your terminal.
Setup asks the HUD itself whether it can see the screen. If not, it tells you the exact `node` to switch on, waits, restarts the
HUD and checks again.

## Try it

Press **Shift + Cmd + Space**, type something like `open Notes and write a shopping list`, press Enter. The first request after
you log in takes a few seconds longer while the agent starts.

Check that everything is healthy any time with:

```
rh doctor
```

## If something goes wrong

| What you see | What to do |
| --- | --- |
| `command not found: rh` | Open a new Terminal window (the install added it to your shell startup files). Or run `~/.remote-hands/bin/rh doctor`. |
| Nothing happens on Shift + Cmd + Space | `rh doctor` says if the HUD is running and holds the shortcut. Another app (Raycast, Alfred) may use the same keys: change its shortcut, then `rh hud install`. |
| "does not have Screen Recording" | In System Settings > Privacy & Security > Screen & System Audio Recording, switch on the `node` that `rh doctor` names, then `rh hud install`. |
| The HUD stopped after updating Node | `rh hud install` rewrites the background service (it finds Node again by itself). |
| After updating Remote Hands, the HUD feels old | `rh hud status` says if the HUD runs an older copy: `rh hud install` updates it. |
| Setup said "Command Line Tools install did not finish" | Finish the macOS install window (or run `xcode-select --install`), then `rh setup` again. |
| You want your agy settings back | `rh permissions revert`. It also stops the background HUD (the HUD cannot run tasks without those settings); `rh setup --hud` brings it back and asks again. |
| You want it all gone | `rh hud uninstall`, then `rh permissions revert`, then delete the `.remote-hands` folder and the `# remote-hands` lines in `~/.zprofile` and `~/.zshrc`. |

Logs are in `~/.remote-hands/logs/` (`hud.log` and `hud.error.log`).

## Already have Node.js?

`npm install -g remote-hands-cli` also works (Node 22.13 or newer), then `rh setup`. The one-line installer is easier because it
keeps its own Node, so a later Node upgrade can never stop the HUD.
