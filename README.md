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
| V | Select & move. Drag empty map to pan; hold the mouse still to ping. Click a door to open or close it |
| R | Ruler (2024: every square, diagonals included, is 5 ft; switch in Settings) |
| P | Ping. **Shift+ping** pulls every player's view to that spot (DM only) |
| C / O / L / B | Sphere, cone, line, cube templates. Squares and tokens caught are highlighted |
| F / H | Reveal / hide fog by area (brushes on the toolbar) |
| W / D / I | Walls, doors and lights (DM) |
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
- **Undo** on any card puts back HP, conditions, effects, spent slots and uses, items and reactions.
- Players can mark slots and resources, tick prepared spells, roll checks and saves, take rests and make death saves from their sheet. Only the DM edits the sheet itself.

New sheets are built from the PDFs with `tools/build_sheets.py` (sources in `tools/chars/`).

## Combat flow

**Reactions ask for themselves.** When something triggers a reaction, the player gets a question on their screen (with a soft chime and a countdown). Answer it and the table re-checks the result. If that player isn't connected, the question appears in your Dice & rolls panel instead, and you decide. Settings → Rules turns this off or changes the countdown (30 seconds by default).

| When | Who | What happens |
| --- | --- | --- |
| You're hit | Boon (Shield), Vali (Parry, Repulsion Shield), Richter (Warding Maneuver) | Shield and Parry raise your AC for that attack and until your next turn; Warding Maneuver adds 1d8 (and resistance if it still hits); Repulsion Shield shoves the attacker 15 ft (walls stop it) |
| Someone next to Richter is hit | Richter | Warding Maneuver for them |
| A party member hits | Sfillian | Crash: the target saves or falls Prone |
| You take damage | Vali (Stone's Endurance), Ash and Vali (Hellish Rebuke) | Stone's Endurance takes the roll off the damage; Hellish Rebuke hits back with a Pact or spell slot |
| You (or someone within 30 ft) fail a save | Boon | Flash of Genius adds +5 if that's enough |
| You fail a save or miss | anyone holding Bardic Inspiration, or a Copper Bead of Iaru | add the die, or reroll |
| A monster makes a save | Sfillian | Dissonance lowers it, before you say how it went |
| A monster casts a spell | Orek, Ash | Counterspell (the monster makes a Constitution save) |
| A monster fails a save | you (the DM) | Legendary Resistance, counted per creature |

A reaction is once per round in combat: it comes back at the start of your turn, and the sheet shows **Reaction used** until then. Using a reaction from the sheet counts too. Bonuses that only matter on a close roll (Shield, Parry, Bardic Inspiration, Flash of Genius, Dissonance) are offered only when they could change the result. That means a Dissonance question does hint that the save was close.

**Turns do their own bookkeeping.** **Next turn** (or N) ends the current turn, then starts the next one.

- **At the end of a turn:** repeat saves happen ("at the end of each of its turns": Hold Person, Hideous Laughter, Phantasmal Killer, Flesh to Stone's three strikes, and any monster ability worded that way). So do areas you end a turn in, like Grease, Spirit Guardians and Moonbeam, and effects that last "until the end of the turn".
- **At the start of a turn:** effects run down, reactions come back, and Heroism tops up temporary HP. Monsters roll to recharge spent abilities (Fire Breath, Recharge 5–6) and get their legendary actions back. Areas you start a turn in take effect, like Web and Stinking Cloud.
- **When a creature moves:** walking into Web or Grease makes it save, once per turn. Booming Blade goes off if its target moves on its own turn. Spirit Guardians moves with its caster.
- Lingering areas end with concentration, or when their duration runs out. A template that's still on the map after the fight can be deleted like any other.

**The monster's turn.** When a monster's turn comes up, a panel opens bottom-left with everything it can do. It shows each of your targets with their distance, whether they're in reach, and any cover. **Multiattack** runs the whole routine in one click (one Bite and three Claws), spreads the attacks over your targets, and moves on when one drops. Recharge abilities show *ready* or *spent*. Legendary actions and Legendary Resistance have their own counters. Pin the panel for any creature from its token (**Show its actions panel**).

## Walls, vision and light

Draw walls on a battle map and each player sees only what their character can see.

- **W** draws walls: drag from corner to corner. Ends snap to the grid and to other walls' ends (hold Shift to place freely). Right-click a wall to remove it.
- **D** draws doors the same way. Anyone can click a door's handle to open or close it. Right-click a handle to lock it (players can't open it), make it secret (looks like a wall to players) or remove it.
- **I** places lights (torch, lamp, lantern, Light, Daylight). Right-click a light to remove it.
- In the bar that opens, tick **Vision** and set the scene's light to **Bright**, **Dim** or **Dark**. In the dark, characters see by light and by darkvision: Ash's Devil's Sight, Gregory's Monocle of Night, and Boon's and Orek's tremorsense while Stonecunning is up. Players pick the light they carry from their character card. **Preview party vision** shows you what the party sees.
- Walls stop players' tokens from walking through them; you can still move anything anywhere.
- **Cover is automatic.** Walls give half (+2) or three-quarters (+5) cover against attacks and Dexterity saves, or total cover (no attack, and outside the area). Spell Sniper and Sharpshooter ignore the partial kinds. To count creatures in the way as half cover, use Settings → Rules.
- Manual fog still works with or without vision.

## Loot and items

Item cards in your prep (the Copper Beads, Mending Draughts, the blasting charges) come with the pack. Under each card in the Prep tab, **Give** hands one to a character. The card then shows who holds it. The Party tab can give any item, including one you make up on the spot.

- On the sheet, usable items appear under **Items** on the Actions tab: potions heal, bombs ask you to place their area, and charges cast their spell. They count down and disappear when used up.
- A **Copper Bead of Iaru** is offered automatically when you fail a Wisdom, Intelligence or Charisma save.
- Players can pass items to each other from the Gear tab.

## Wrapping up a session

**Wrap up** (top bar) writes the session up in Markdown from what happened at the table:

- a first draft of *Previously on…* for you to edit
- the scenes in order, each fight (foes, rounds, who fell and who went down) and its highlights
- every clock's start and end
- what everyone carries, and the party's HP, slots and spent resources
- your prep's own *After the session* checklist, with the answers the table already knows filled in

Add your notes, then **Download .md** and put the file in your DM Story Assistant project. The next prep picks up its *Previously on…*, ledgers and clocks from it. **Save & start the next session** keeps a copy with the campaign and starts a fresh journal.

## Image Kit (pictures with Gemini)

Prep tab → **Image Kit…** makes every picture the table needs: token art for each creature and character, battle maps, scene art and NPC portraits.

1. **Copy the Image Kit** and paste it into a new Gemini chat with Canvas turned on. Gemini runs it as a small app; your Gemini plan covers the pictures.
2. **Copy the list** and paste it into the kit. Click **Generate missing**, check each picture (edit a prompt and **Make another** if one misses), then **Download zip**.
3. Back in Erta Table, **Load images (.zip)** (or drop the zip on the map). Scenes and battle maps get their backgrounds and grids, tokens on the map and every new token of that creature wear their art, characters get their token, and portraits become handouts you can show from the prep.

With a Gemini API key you can skip Canvas: **Open the Image Kit** runs it on this site, and **Send to** puts the pictures straight into the open table. The kit itself is `image-kit.html`.

## Session packs

`tools/prep_to_pack.py` turns a prep page into a pack: scenes, soundtrack slots, handouts, stat blocks, encounters, clocks and item cards. `python3 tools/prep_to_pack.py --items packs/<pack>.json data/srd-spells-2024.json` re-reads the item cards of a pack that's already built.

## Roadmap

- A session pack with every new prep.
- Opportunity attacks when a creature leaves reach; movement range while dragging.

## If a player can't connect

Most home networks connect fine. A few strict networks (some offices, schools, mobile carriers) block direct browser-to-browser connections. The fix is a relay ("TURN server"); add one to `ICE_SERVERS` in `config.js`.

## Credits

Monster stat blocks and spells: this work includes material from the System Reference Document 5.2 ("SRD 5.2") by Wizards of the Coast LLC, available at https://www.dndbeyond.com/srd and licensed under the Creative Commons Attribution 4.0 International License (https://creativecommons.org/licenses/by/4.0/legalcode). Converted from the data in the [Foundry VTT dnd5e system](https://github.com/foundryvtt/dnd5e). 3D dice: [dice-box-threejs](https://github.com/3d-dice/dice-box-threejs) (MIT). Condition icons: Lorc, Delapouite and contributors, [game-icons.net](https://game-icons.net) (CC BY 3.0). Networking: [PeerJS](https://peerjs.com) (MIT). Backups: [JSZip](https://stuk.github.io/jszip/) (MIT).
