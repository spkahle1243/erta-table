# Erta Table

A virtual tabletop that runs in the browser, for the **Erta** campaign and the **Ironclad Inquiries** one-shots. D&D 5e (2024 rules).

- **DM view:** https://spkahle1243.github.io/erta-table/
- **Players** join from their own character link (DM view → Party tab → copy link). No accounts, nothing to install.

## How it works

Your DM tab *is* the game server, the way your Foundry install is. Players' browsers connect straight to it. A free matchmaking service (PeerJS) introduces the browsers to each other; after that, all game traffic, maps and music go directly between you and your players.

- Keep the DM tab open for the whole session. If it closes or your computer sleeps, players see "Reconnecting…" and rejoin by themselves when you reopen the campaign.
- Everything (campaigns, maps, music) is saved in this browser on this computer. **Back up** (top bar) downloads one file you can restore anywhere; player links keep working after a restore.
- Maps, tokens and music upload from you to each player the first time they're needed, then stay cached in the player's browser.

## Game night checklist

1. Open the DM view and click **Open table** on your campaign. Wait for **● Table open**.
2. Send each player their link from the **Party** tab (once; links don't change unless you make a new one).
3. Pick a scene, set it up, and click **Show this scene to players**. The scene's music and ambience start automatically if you set them.
4. Players click **Take your seat** (this lets their browser play sound).

## Controls

| Key | Tool |
| --- | --- |
| V | Select & move. Drag empty map to pan; hold the mouse still to ping |
| R | Ruler (2024: every square, diagonals included, is 5 ft; switch in Settings) |
| P | Ping. **Shift+ping** pulls every player's view to that spot (DM only) |
| C / O / L / B | Sphere, cone, line, cube templates. Squares and tokens caught are highlighted |
| F / H | Reveal / hide fog by area (brushes on the toolbar) |
| Delete | Remove the selected token or template |
| Arrows | Nudge the selected token one square |

Mouse wheel zooms; right-drag pans; right-click a token for HP and conditions. Drop an image on the map to add a token (it starts hidden), or on an empty scene to set its background. Drop audio files to add them to the library.

## If a player can't connect

Most home networks connect fine. A few strict networks (some offices, schools, mobile carriers) block direct browser-to-browser connections. The fix is a relay ("TURN server"); add one to `ICE_SERVERS` in `config.js`.

## Credits

Condition icons: Lorc, Delapouite and contributors, [game-icons.net](https://game-icons.net) (CC BY 3.0). Networking: [PeerJS](https://peerjs.com) (MIT). Backups: [JSZip](https://stuk.github.io/jszip/) (MIT).
