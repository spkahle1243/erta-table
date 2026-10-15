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
| T | Target (or un-target) the token under the mouse. T over empty map clears your targets |
| S | Open or close your character sheet (players) |
| N | Next turn in combat (DM) |

Mouse wheel zooms; right-drag pans; right-click a token for HP and conditions. Drop an image on the map to add a token (it starts hidden), or on an empty scene to set its background. Drop audio files to add them to the library.

## Character sheets and automation

Characters with a converted sheet (Party tab → **Open sheet**) get full automation. The DM's tab is the referee: it holds every stat block, rolls in the roller's colour so everyone sees the dice, applies the result and posts a card to the log.

- **Attacks:** target with T, then click **Attack** on the sheet (or **Attack ▸** on a monster's stat block). Advantage and disadvantage come from conditions and effects (Vow of Enmity, Sapped, Prone, Restrained, Invisible…), crits double the dice, damage applies resistances, immunities and temporary HP. The **⋯** button holds the riders: Divine Smite (slot spent only on a hit), Shield Bash, maneuvers, True Strike, versatile grip.
- **Spells:** **Cast** spends the lowest free slot; **⋯** picks a higher slot, a Pact slot, a ritual, a damage type, or Arcane Firearm. Area spells ask you to place the area on the map, then everyone inside saves. Players whose characters are caught get a **Roll** prompt; the DM sees who is still to roll and can **Roll for them**. Damage is rolled once for everyone (2024).
- **Effects** (Bless, Bane, Hunter's Mark, Bladesong, Haste, Hold Person…) show on tokens, count down at the start of the caster's turn, and end when concentration breaks. Concentration saves happen automatically when a concentrating creature takes damage; Aura of Protection is added to saves in range.
- **Undo** on any card puts back HP, conditions, effects and spent slots or uses.
- Players can mark slots and resources, tick prepared spells, roll checks and saves, take rests and make death saves from their sheet. Only the DM edits the sheet itself.

New sheets are built from the PDFs with `tools/build_sheets.py` (sources in `tools/chars/`).

## Roadmap

- **Case 3 test run** with the DM before game night.
- **Gemini Canvas "Image Kit":** a small app to paste into Gemini Canvas. Erta Table copies a pack's image prompts with one click; the kit generates them with your own Gemini login and downloads one zip named by scene, portrait and handout; dropping the zip on Erta Table files every image in its place.
- A session pack with every new prep.

## Roadmap

- **Image Kit (Gemini Canvas).** A small app to paste into Gemini Canvas. Erta Table copies a pack's image prompts with one click; the Image Kit generates them with your Gemini login and downloads one zip named by scene, portrait and handout; dropping the zip on Erta Table files every image in its place.
- A session pack with every new prep.

## If a player can't connect

Most home networks connect fine. A few strict networks (some offices, schools, mobile carriers) block direct browser-to-browser connections. The fix is a relay ("TURN server"); add one to `ICE_SERVERS` in `config.js`.

## Credits

Monster stat blocks and spells: this work includes material from the System Reference Document 5.2 ("SRD 5.2") by Wizards of the Coast LLC, available at https://www.dndbeyond.com/srd and licensed under the Creative Commons Attribution 4.0 International License (https://creativecommons.org/licenses/by/4.0/legalcode). Converted from the data in the [Foundry VTT dnd5e system](https://github.com/foundryvtt/dnd5e). 3D dice: [dice-box-threejs](https://github.com/3d-dice/dice-box-threejs) (MIT). Condition icons: Lorc, Delapouite and contributors, [game-icons.net](https://game-icons.net) (CC BY 3.0). Networking: [PeerJS](https://peerjs.com) (MIT). Backups: [JSZip](https://stuk.github.io/jszip/) (MIT).
