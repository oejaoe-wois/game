# aio-farm

Headless multi-account farm orchestrator for the game. It is a Node.js port of
the HTTP core of your **All-In-OneUI** browser extension: same endpoints, same
CSRF login flow, same wave-page discovery regex, same boss combat logic — but
every account runs as its own isolated cookie-jar "container" in one small
process, 24/7, on a free host.

Zero dependencies. Node >= 18.14. No browser, no Chrome, ~50 MB RAM.

```
┌─────────────────────────┐        HTTPS + X-Admin-Token        ┌──────────────────────────────┐
│ Vercel / GitHub Pages   │ ──────────────────────────────────▶ │ Wispbyte Node server          │
│ static panel (public)   │      POST /api/accounts             │  aio-farm engine              │
│ repo holds ZERO secrets │      DELETE /api/accounts/:id       │                               │
└─────────────────────────┘      GET  /api/status|targets      │  scout ──▶ target bus         │
                                                                │    │  (mob ids, bosses)       │
        friend's browser ──▶ enters game email+password once ──▶│    ▼                          │
                                                                │  worker×N (cookie jar each)   │
                                                                │   ├─ boss combat loop         │
                                                                │   └─ precision wave farming   │
                                                                │      (gates/waves, or legacy  │
                                                                │      server-side auto-farm)   │
                                                                └──────────────┬────────────────┘
                                                                               │ form posts
                                                                               ▼
                                                                 https://demonicscans.org
```

## Why it is built this way

| Your idea | Reality | What was built |
|---|---|---|
| Run the extension zip on Wispbyte 24/7 | The zip is a Chrome MV3 extension; Wispbyte free = 512 MB RAM, no browser | The extension's HTTP core (which did 90% of the work anyway) ported to Node |
| Passwords "stay on the page", server never sees them | Impossible: the bot must log in, so credentials must reach it; a static page is public | Credentials travel once over HTTPS to the API, are sealed with **AES-256-GCM** (key in an env var), never returned — not even masked |
| Firefox-containers isolation per account | — | One `CookieJar` + worker loop per account in a single process: separate sessions, parallel execution, ~10 MB per account |
| Scout account broadcasts "attack this mob id" | — | Scout worker parses the wave pages (`data-monster-id` regex port), matches boss names, publishes to a shared target bus; every farmer subscribes |

## Two sites, all accounts in parallel

The farm runs **demonicscans.org and veyragame.com side by side**:

- **One container per account.** Every account owns its own `GameClient` and
  cookie jar (the "Firefox container": sessions never mix) and its own async
  loop. Nothing is shared between accounts and nothing queues them — they all
  work at the same moment.
- **One engine per site.** Each site has its own (optional) hidden fetcher, scout,
  target bus (`data/targets.json`, `data/targets-veyra.json`) and gate/wave
  list. A mob id from one site is never handed to the other.
- **Add accounts per site.** Pick the site in the panel's add form (or send
  `"site": "demonic"` / `"veyra"` to `POST /api/accounts`). The same email can
  be added on both sites; they are two independent accounts.
- **Veyra is lazy.** It makes zero requests until its first account is added,
  then brings up its fetcher and scout on its own.
- **Startup stagger** (`LOGIN_STAGGER_MS`, default 45 s) only spaces out the
  *first login* of each account, per site. Lower it to start faster; once
  running, every account works continuously and independently.
- Read endpoints take `?site=veyra`: `/api/targets`, `/api/spawns`,
  `/api/waves`, `/api/battle/:id`.

> Veyra's login page uses the same `/game_login.php` form flow. Battle, wave
> and shop pages are assumed to match the main site; if Veyra's gate/wave ids
> differ, set `WAVE_PAGES_VEYRA`. Test with a single account first and watch
> its `lastError` in the panel.

## Deploy on Wispbyte (the 24/7 engine)

1. Create a free Node.js server (free plan = 512 MB RAM — plenty for 10+ accounts).
2. Upload this project: zip upload or connect your GitHub repo. **Never commit
   `data/` (encrypted credentials + audit) or real env values.**
3. Set the environment variables (Startup / Env Vars). Minimum:

   | Variable | Value |
   |---|---|
   | `ADMIN_USERNAME` | the **owner's** panel login name (default `admin`) — you |
   | `ADMIN_PASSWORD` | the owner's panel password — long random string, 8+ chars. Friends do **not** share this: you create them their own logins from the panel (see *Multiple people* below) |
   | `AIO_SECRET_KEY` | 32+ random chars — master key for the encrypted store. Keep a copy: if it changes, the server refuses to boot (it says so) rather than failing every login |
   | `ADMIN_GAME_EMAIL` | OPTIONAL — the hidden built-in fetcher's game login. Set it to reserve one game account for read-only page sweeps; leave it empty and **every** game account fights, swarms and hunts (the scout then rides the oldest healthy worker's session) |
   | `ADMIN_GAME_PASSWORD` | the fetcher's game password — required only when `ADMIN_GAME_EMAIL` is set, no default, set only here |
   | `TRUST_PROXY` | `1` on Wispbyte (reverse proxy) so rate limits/login lockout count each visitor's real IP |
   | `GAME_BASE` | `https://demonicscans.org` |
   | `PORT` | `3000` (or the port Wispbyte assigns) |

   Optional tuning: `JITTER_SCALE`, `LOGIN_STAGGER_MS`, `SCOUT_INTERVAL_MS`,
   `MAX_FARM_TARGETS`, `HIT_DELAY_MS`, `PACE_MIN_MS`/`PACE_MAX_MS`,
   `CYCLE_MIN_MS`/`CYCLE_MAX_MS`, `ALLOWED_ORIGINS` (lock CORS to your Vercel
   URL), `EXP_POLL_MS`, `DISCORD_WEBHOOK_URL` (optional Discord pings),
   `LOG_LEVEL`, the wave-farming knobs `MOB_DAMAGE_CAP`, `MOB_CAP_MODE`,
   `WAVE_FARM_MODE`, `WAVE_MOBS_PER_ROUND`, `WAVE_HIT_DELAY_MS`,
   `WAVE_PAGES`, and the stat-allocation knobs `STAT_PLAN`,
   `STAT_AUTO_ALLOCATE`. See `.env.example` for the full list.
4. Startup file / entry: `server/index.js` (or `npm start`).
5. Start and check the console: you should see `panel + admin API listening on :3000`.
   The public URL of that port is your **server URL** for the panel.

> Wispbyte free requires a panel login every 2 weeks or the server stops.
> Files survive; log in and press start again. Put a reminder in your phone.

## The panel — two ways to open it

The panel is a small multi-page static site in `web/` (sign-in + one page per
concern: Dashboard, Accounts, Targets, Stats, Users). Pick ONE of these:

**Option A — served by the farm itself (default, zero extra hosting).** The
Node server now serves `web/` on the same port as the API. Open
`https://your-server/` and sign in. Same-origin calls, no CORS setup, no
Vercel needed. Nothing about it is secret — the static files hold zero
credentials; every API call still needs the session token.

**Option B — separate static hosting (Vercel / GitHub Pages), if you prefer.**

1. Deploy **only the `web/` folder** as a static project (drag & drop on
   vercel.com, or `vercel` CLI, or GitHub Pages).
2. Open the page. Enter:
   - **Server URL**: your Wispbyte public URL (e.g. `https://xxx.wispbyte.net`)
   - **Username + password**: your own login (the owner uses `ADMIN_USERNAME` / `ADMIN_PASSWORD`; friends use the login the owner made for them)
3. The server URL and session token are saved in the **visitor's own
   localStorage** — the page source and the repo contain no secrets.

> Hosting the panel elsewhere? Set `ALLOWED_ORIGINS=https://your-panel.example`
> on the farm server so its CORS allow-list covers the panel origin.

### Multiple people (owner + friends)

Everyone signs in with **their own username and password** and only ever sees
and controls the game accounts **they added themselves**.

- **Owner** (`ADMIN_USERNAME` / `ADMIN_PASSWORD`): sees every account (with who
  owns it), can pause the whole farm from the Dashboard, and manages friend
  logins in the panel's **Users** page (create, reset password, delete).
- **Friends**: sign in, add/remove/relogin their own game accounts, view their
  own status and stats, allocate stats and buy potions on their own accounts.
  They cannot see other people's accounts, pause the farm or see the user list.
- Re-adding an email you already added = "fix my password". Adding an email
  that another person already added is **refused**, so nobody can take over
  someone else's game account.
- Deleting a friend also removes their game accounts (stored passwords are
  destroyed) — or hands them to the owner with `?accounts=keep` via the API.
- Friend panel passwords are stored as salted **scrypt hashes** in
  `data/users.json` (the farm can't recover them, only check them). Game
  passwords stay AES-256-GCM encrypted in `accounts.enc` as before. Back up
  the whole `data/` folder.
- Accounts added before multi-user support have no owner and belong to the
  owner. The shared pieces stay shared on purpose: one built-in fetcher and one
  target bus feed everybody's accounts.

### API (for scripts/curl)

All routes need a session token from `POST /api/login` (header `X-Admin-Token: <token>` or `Authorization: Bearer <token>`):

| Method | Path | Body / Notes |
|---|---|---|
| POST | `/api/login` | `{username, password}` — the panel's login (no secret keys). Returns `{token}` (64-hex session, in-memory, `SESSION_TTL_HOURS` default 7 days, gone on restart). Rate-limited 8 tries / 5 min / IP. Every other route takes `X-Admin-Token: <token>` (or `Authorization: Bearer`). An optional legacy `ADMIN_TOKEN` env still works as a master token for curl/scripts |
| POST | `/api/logout` | revokes the session token |
| GET | `/api/me` | `{username, role}` of the caller (`owner` or `user`) |
| GET / POST | `/api/users` | **owner only.** List friend logins (with account counts) · `{username, password}` create one |
| POST | `/api/users/:name/password` | **owner only.** `{password}` reset it (signs them out) |
| DELETE | `/api/users/:name` | **owner only.** `?accounts=remove` (default) or `keep` |
| POST | `/api/accounts` | `{nickname, email, password, guildCode?, classPick?}` — adds + queues a worker. `guildCode` (optional, ≤64 chars) is the game guild this account fights for: tag (`DA`/`[DA]`), full name, or numeric id — the worker verifies it before every guild-dungeon run. `classPick` (optional) is the classes.php policy: `auto` (default — bind the optimal farming class at level 200+) · `mage` · `warrior` · `hunter` · `cleric` · `off` (never POST — the in-game choice is permanent) |
| GET | `/api/accounts`-via-`/api/status` | masked emails, statuses, levels, errors |
| POST | `/api/accounts/:id/relogin` | force a fresh login |
| PATCH | `/api/accounts/:id` | `{classPick?, guildCode?}` — re-points a running account's policy live: the per-account class policy (`auto`/class key/`off`) and/or the guild code (the guild verdict re-verifies on the next dungeon round). The GAME's class choice stays permanent — this only changes what the engine does from now on |
| DELETE | `/api/accounts/:id` | stops worker + destroys stored password |
| POST | `/api/scout` | `{accountId}` designate the fetcher account · `{}` clears (auto-pick) |
| GET | `/api/targets` | what the scout currently broadcasts (mob ids + view links) |
| GET | `/api/battle/:id` | view-only battle peek (`battle.php?id=`) via a logged-in account — zero stamina, returns `{found, dead}` |
| POST | `/api/farm` | `{enabled:false}` global pause — **owner only** |

Every account route is scoped to the caller: friends only see/act on their own accounts (others answer 404 / `no_such_account`), the owner sees all.
| POST | `/api/stats/allocate` | `{accountId?, plan?:{attack,defense,stamina}}` or `{accountId?, targets?:{attack,defense,stamina}}` — run the allocatePlan (fixed amounts) or allocateTargets (spend up to goals) engine now; omitted → `STAT_PLAN` / `STAT_TARGETS`. Returns the per-stat report (chunks applied, resyncs, points left) |
| GET | `/api/stats` | per-account stat snapshot (banked points + attributes) + the configured plan / targets / auto flags |
| GET | `/api/spawns` | the scout's last auto-summon scan — per boss: alive, next-spawn ts, 48h phase (1 = wait, 2 = damage counts), remaining life, "You:" damage |
| GET | `/api/waves` | the gate/wave registry + cap mode (`MOB_CAP_MODE`), learned loot-gate count, mobs per round |
| POST | `/api/shop/stamina` | `{accountId?}` — run the potion-shop buy-all on one account now (merchant → guild → Damon); returns the per-shop summary |
| GET | `/api/hunt` | `?site=` — the fleet-hunt state: the unified mob (non-null when every account hunts the same list) + per-account rows |
| POST | `/api/hunt` | `{mob, site?}` — **"attack all <mob>"**: the SAME dive targets land on every accessible account of the site, live (workers re-arm in place; each account's next cycle bus-dives the matching live mob ids, then keeps hunting them on their pinned waves). `mob:""` clears |
| DELETE | `/api/hunt` | `?site=` — stand the fleet down (same as `mob:""`) |
| GET | `/api/swarm` | `?site=` — the swarm-attack coordinator's view: queue, current target, per-account banked damage, timestamped log, plus `dungeonMobNames` (the dungeon mob types the fleet last saw, for the quick-pick chips) |
| POST | `/api/swarm` | `{targets:[{kind:"wave",mobId,name?,wave?,quota} or {kind:"dungeon",name,quota}], mode:"per_account"|"total", autoRefill?, site?}` — arm a swarm job (replaces a running one). Wave targets are mob IDS from the live-mobs list; dungeon targets are mob-TYPE names |
| DELETE | `/api/swarm` | `?site=` — stop the swarm and freeze the queue (workers fall back to normal farming) |
| GET | `/api/monster-stats` | `?site=&mobId=` — the mob TYPE's "View Monster Stats" block (Defense / Pet Defense / Equipment Defense / Element / Element Rate / Rewards Up To LV / the four resistances) parsed off the zero-stamina battle view, cached per type (30 min), plus a fleet-average damage-formula forecast (`avgHit`, `countered`) |
| POST | `/api/equip` | `{accountId?}` — run equip-best NOW on one account (inventory parsed, strictly-better items worn) |
| POST | `/api/blacksmith/craft` | `{accountId?}` — run a blacksmith craft sweep NOW on one account (every gate swept, craftable recipes forged) |
| GET | `/healthz` | no token — uptime probes |
| GET | `/*` (anything else) | the panel itself — `web/` static files, no secrets, no token needed to download |

## What each worker does every cycle

0. **SWARM ATTACK first when a swarm job is armed** (Targets page "Swarm
   attack" card / `POST /api/swarm`): the worker claims the queue's CURRENT
   wave target (by mob id) and fights it until the account's remaining
   quota is banked — the fleet moves to the next mob only when every live
   account met its share. Dungeon targets route the cycle through the
   guild-dungeon floors with the swarm filter instead (see "Swarm attack"
   below).
1. **Boss targets first** — the scout published live boss instances (mob ids)
   from the wave pages; the worker attacks the ones enabled for its level
   group (c1/c2/c3 caps, same as the extension's presets). Combat is the
   ported probe → optimal-tier loop with the v444 tail optimization, marked
   handling, stamina step-down, heal potion (`user_heal_potion.php`), auto-farm
   3-strike reset, and the phase-2 PVP solver with `pvp_style_state.php`
   keep-alive pings. Out of stamina with no tier left to step down to, it
   drinks from inventory (see the endpoint table below) and keeps going.
   **48h auto-die bosses in phase 1 are skipped** (Boss Tracker rule — damage
   doesn't count until the final 24h; see the spawn-timer section below).
   The extension's `saveBossMonsterId` rule is ported too: once THIS account
   has taken a boss instance to its cap (or found it dead) it remembers the
   mob id per boss key and moves on to wave farming — a finished boss never
   starves the waves, and a NEW instance id on the same key re-arms it.
2. **Otherwise — BUS DIVE first when the fleet hunt is armed** (Targets page
   "Fleet hunt" card / `POST /api/hunt`): with dive targets set, the worker
   hits every LIVE bus mob id matching them — join + slash to death, whatever
   wave the mob lives on — before the wave round (see "Fleet hunt" below).
   **Then — precision wave farming** (default, `WAVE_FARM_MODE=precision`):
   the worker visits ONE page per cycle, round-robin over the gate/wave
   registry (`config/waves.json`: Grakthar = `gate=3` waves 3/5/8, Olympus
   = `gate=5` wave 9 + the named god domains 10-17 — Hermes, Artemis,
   Poseidon, Ares, Apollo, Athena, Hera, Zeus; labels are the game's own
   live-verified naming). On the page it reads each mob card (name, dead
   flag, the instance's `data-expire` auto-die timer, the account's own
   cumulative **"You:" damage**), skips dead mobs and mobs already at their
   per-mob damage cap (see the loot-gate section below — every wave and gate
   carries different numbers), then joins and 1-stamina-slashes the
   survivors until the mob dies, the cap is hit, or stamina runs dry (the
   potion ladder refills before the next round). Workers offset the
   round-robin by their index, so N accounts spread across the gates (the
   LevelUp Looter's event waves like `active_wave.php?event=13&wave=116` are
   registry entries too). **The game's own auto-farm now gets PAUSED by the
   worker** (default `AUTO_FARM_FIX=1`): while it is enabled the game
   rejects every manual hit (`damage.php` → "your auto farm is on"), so the
   worker reads `auto_farm_status.php` (`settings.IS_ENABLED`), sends the
   Auto Farm card's own Pause call (`auto_farm_actions.php
   action=toggle&enabled=0`), VERIFIES the pause via a second status read,
   audits `auto_farm_disabled`, and resumes hunting — verified live
   2026-11 (the main account shipped with auto-farm ON; after the pause the
   same join+slash chain landed 13,987-damage hits, HTTP 200). It also
   checks once at every fresh login so the first round hunts instead of
   collecting 400s. `AUTO_FARM_FIX=0` restores the old warn-only behaviour
   (one warning per session + the panel's Last-error hint).
3. **Guild dungeon cycle** (`DUNGEON_FARM`, on by default — DungeonCleaner +
   LevelUp Looter): the hub's NAMED cards (`guild_dungeon_enter.php?id=` +
   title + the STABLE `dungeon_info.php?id=` kind link → kind 1 Shadowbridge
   = easy, kind 2 Castle = hard, kind 3 Polyhedral = poly/cube layout) get
   their FIXED floor rosters scanned (mob floors then boss rooms). `.mon`
   cards are parsed with the game's state pills — only `DEAD_LOOTABLE`
   corpses (dead + joined + not looted) are collected via `dungeon_loot.php`,
   bosses first by expected EXP = min(your `#yourDamageValue` damage, the
   boss's dmgLimit) × its ratio (the card's own `EXP/dmg` statpill when the
   floor shows one, the `BOSS_STATS` table as fallback); the live ones are
   joined (`dungeon_join_battle.php`) and Slashed (`damage.php` with
   `instance_id` + `dgmid`), capped at `DUNGEON_MOBS_PER_CYCLE` per cycle so
   the waves keep their share. If a floor's healbox shows the PLAYER dead
   (revive countdown), the cycle stops and waits for the auto-revive instead
   of burning joins.

   **Instance lifecycle** (live-server verified): the
   `guild_dungeon_enter.php?id=N` / `guild_dungeon_instance.php?id=N` ids are
   PER-OPEN and globally monotonic — every open gets a fresh id, so the
   engine never caches them and re-reads the hub every cycle (the hub is the
   only source of truth). The guild can have one dungeon of each kind open
   per day; a run persists until it is CLEARED or the leader/vice CLOSE it.
   Uncleared runs linger on the hub's ended grids as "Status: ended — Not
   looted — Awaiting leader/vice to loot" (or "Status: failed — No loot")
   with their mobs locked for members — the cycle SKIPS those (counted in
   `endedSkipped`) instead of wasting requests on them for days. A kind card
   without an Enter link ("Only leader/vice can open.") simply means no run
   of that kind is open right now; when the leader opens one mid-day the
   next cycle picks it up with its fresh id.

   **Guild code** (the panel's optional field on add-account): the engine
   reads the session's own guild off every hub it already fetches
   (`guildId = N;` in the page script) and, for tag/name codes, one
   `guild_dash.php` probe per session (its `<h1>` = `[ TAG ] Guild Name`; the
   game ignores `?guild_id=` — it always answers the CALLER's guild). A
   code that matches the id (`32`), the tag (`DA` / `[DA]`) or the name
   (`Dagorath Alliance`) arms the cycle; a MISMATCH stops the dungeon farm
   with a `GUILD_MISMATCH` audit entry and a zero-fight cycle — people only
   ever attack their own guild's mobs. The panel's accounts table shows the
   detected guild + the verdict (✓ match / ✗ wrong / ? pending).

   **Multi-guild (friends in DIFFERENT guilds): every account scans its
   own.** `scanGuild()` runs on every worker cycle regardless of the dungeon
   config — one `guild_dash.php` GET (throttled to first-sight + gap-fill +
   a 30-min refresh), so a friend who never enters a guild code still gets
   their guild detected (`id` + tag + name) and shown in the panel, and
   their dungeon farm works off their own guild's hub (the hub only ever
   lists the session guild's runs). Guild codes stay per account and are
   optional; a mid-session guild SWITCH is caught two ways — the 30-min
   re-scan, and the dungeon hub's `guildId` const changing — and
   `mergeGuild` then DROPS the cached tag/name (they belong to the old
   guild) before re-probing the new identity, logging a `guild_change`
   audit entry. Nothing is shared between accounts: sessions, guild caches
   and verification are all per worker.

   **Guild auto-join — "accept guilds" (live-verified 2026-11-23).** An
   account that carries a panel guild code but answers GUILD-LESS no longer
   waits for a human: `scanGuild()` finds no guild and the new
   `maybeAutoJoinGuild()` hook makes the account MATCH its code
   (`server/guilds.js`):

   1. **Search** — `GET /guild_join_create.php?q=<code>` ("The guild
      registry", 700+ guilds) parsed from the live `.gd-card` rows: tag,
      name, recruitment badge ("Open recruitment" / "Application" / "Full"),
      "N / M members". The code matches the tag (`DA` / `[DA]`), the exact
      name or the numeric id — case-insensitive, the same rule
      `guildMatches` uses for the verdict.
   2. **The join form** — the guild's detail page renders ONE
      `.gd-action-form` to a guild-less viewer: hidden `csrf` + `form_id` +
      `guild_id` + `action` — `join_open` ("Join this guild", instant
      membership) or `apply` ("Send application", optional ≤1000-char note)
      for Application-mode guilds. A FULL guild renders no form plus "This
      guild is currently full." — answered, never POSTed. A member viewer
      sees no form at all.
   3. **Authoritative verification** — after the POST the dash is re-probed
      (`fetchOwnGuild`): the game's own answer to "whose member am I now".
      `joined` → the existing verdict flow takes over (dungeon farm + guild
      contracts unlock with no config change); `applied` → the panel shows
      "application sent — waiting for the leader" and the cooldown
      (`GUILD_JOIN_COOLDOWN_MS`, default 30 min) keeps it from becoming a
      POST loop.

   Guards: NO guild code → never join blind (the engine never picks a guild
   for you); `GUILD_AUTO_JOIN=0` disables farm-wide; an account already in a
   guild is only ever VERIFIED against its code, never moved. Every attempt
   lands in the audit log (`guild_join`) and the panel's guild cell shows
   the attempt (`join=joined (joined [DA] Dagorath Alliance)`). The live run
   (`scripts/live-guild-join.js`) took a guild-less LV 319 account to a
   verified [DA] member in ~70 s with the other two accounts untouched.

   **Cube dungeons are farmed now** (they were skipped as "broken" before
   the cube page was understood — they are not): cube instances redirect to
   `guild_dungeon_cube.php?instance_id=X`, a JS page embedding the run state
   as `const STATE = {…}` — six faces, nodes, weekly guild leaderboard. The
   engine parses that STATE, POSTs `guild_dungeon_cube_action.php
   {action:'enter_node', instance_id, node_id, face_key}` for every available
   combat node (keeps run progress/unlocks coherent server-side; the reply's
   `redirect` names the linked floor), then farms the linked floors (11–13
   mob rooms + 14 Apex gate on the live server) with the regular
   loot/fight machinery. The live Polyhedral Crucible itself is a cube-layout
   dungeon (hub card tag "Cube Layout", kind id 3): its instance page
   redirects to the cube page too, so poly runs go through the same node
   flow — with the fixed poly roster as fallback when the STATE blob cannot
   be read. `DUNGEON_CUBE=0` skips all cube-layout dungeons again if you
   ever want the old behavior.
4. **Reaction stamina farm batch** (`REACTION_FARM`, on by default — the
   stamina-farm script port): a few manga-chapter reactions per cycle
   (`/postreaction.php`, +2 stamina each) while the bar is below max, with
   the script's own `reacted_chap_<id>` cookie dedupe, daily caps and no-gain
   stop.
5. **Corpse sweep** (`CORPSE_LOOT=smart`, default): when the bar is dry or
   ≤ `CORPSE_STAMINA_BELOW` (the LevelUp Looter's autoloot threshold,
   default 10) or EXP is ≥ 80% (a level-up refills stamina), the worker
   scans the waves in the game's `show_dead_bosses_only` view — ALL
   `dead_page` pages of them — and loots every corpse it has damage on
   (`loot.php` with `monster_id`, `dgmid`, `instance_id:'0'` and the
   battle.php Referer), BEST-EXP FIRST (each mob's battle page carries
   `EXP Cap ~N` and `EXP / DMG` stat blocks; expected = min(damage, cap) ×
   rate). "Not dead yet / already looted" replies count as skipped, not
   failed. When the sweep covers the EXP gap to the next level it stops —
   and raises the wave page's **Max Large/Full Stamina Potions to use** by
   `POTION_CAP_RAISE` amounts for the auto-battle.
6. **Every kill is manually looted** (`WAVE_LOOT_KILLS`, on by default):
   the moment a wave mob dies the worker POSTs `loot.php` — the exact
   request the game's own Loot button makes. The Dragon Realm event's
   hunting dailies count only "defeat N X and **manually loot** it today"
   ("Auto-Farm and Auto-Loot do not count"), unclaimed kills expire
   without their drops, and the corpse sweep already proved the request
   shape — so the hook costs one cheap POST per kill and feeds both the
   event dailies and the inventory.
7. **The missed-game sweep** (end of every cycle, user accounts only — the
   built-in fetcher stays lean): achievements + collections claims, the
   Adventurers Guild contract loop, the event daily contracts and the
   battle pass season (quest progress + wave steering + reward claims),
   each internally throttled so an idle check costs one cheap GET. See the
   next section for the full breakdown and the env switches.
8. **Sessions die** — any login-form response triggers a re-login with
   cooldown `RELOGIN_COOLDOWN_MS`.

## Divers — the engine's own hunting system

There are TWO auto farmers in this picture: the **game's built-in one**
(the wave page's Auto Farm card, `auto_farm_actions.php`) and **Divers** —
this engine's own hunters. The game refuses every manual hit while ITS
farmer runs, so every worker pauses it at login and whenever a fight hits
the rejection (see cycle item 2), and Divers then hunt the way you tell
them to. Four pillars share one wave registry:

1. **The gates** — the round-robin over `config/waves.json` (Grakthar
   waves 1–3, Olympus wave 1 + the eight named domains). Workers offset by
   index so N accounts cover the registry in parallel.
2. **Battle pass** — `battlepass.js`: season dailies, wave steering toward
   the quest's mob family, tier + quest reward claims (section below).
3. **PvP** — `pvp.js`: reads the season board (title, leaderboard rank,
   tier, battle tokens) and matchmakes **only while the season is open and
   tokens remain** (`POST pvp_matchmake.php {ladder}` → follow the battle
   redirect; token refills are never auto-spent — they cost gems). A closed
   season (the live state 2026-11-22: "Solo matchmaking is closed.") is a
   clean no-op that still reports tier/tokens/rank to the panel
   (`pvp 1m · 30tk` on the account row). `PVP=0` disables;
   `PVP_MAX_MATCHES` caps tokens per round.
4. **Events** — the dynamic registry: the scout discovers each live
   `event_page.php`'s wave links (`active_wave.php?event=N&wave=M`,
   persisted to `data/event-waves.json`), and those pages join the
   round-robin and the sweep at runtime. Event dailies + kill-looting ride
   the same pages.

**Dive targets** (the per-account hunt list): set "Dive targets" on an
account in the panel — `goblin skirmisher, troll ravager; Orc Grunt` —
and that account hunts EXACTLY those mobs: matching cards are attacked
FIRST on every page it visits, and the wave picker goes STRAIGHT to the
pages that host them (multi-target divers rotate across all their pinned
pages; the account row shows `dive 12/3t → Grakthar · wave 2`).
`DIVE_ONLY=1` makes the diver attack NOTHING but its named mobs — stamina
only ever buys the hunt.

**The hunt map** (`hunt.js` + `data/hunt-map.json`) is what makes the
steering instant: `config/mobs.json` seeds it with the live-scraped
rosters of every registry page (Grakthar 1–3, Olympus + domains — mob
names AND boss names, so a diver sent after "drakzareth" pins the wave-3
boss page on round one). Every parsed wave page re-teaches the map, and a
live sighting always outranks a seed. Seeded rows are HINTS, not pins —
the picker probes a seeded page first but only hard-pins after a live
sighting, and any pin whose round saw none of its mobs DEMOTES itself
(one log line) so the rotation takes over and the next sighting re-pins.
A wrong seed can therefore never trap an account on a barren page.

**Loot-cap steering**: every wave banner reads "Rewards Up To LV X" (live:
Grakthar wave 1 = LV 300). Past that level the wave still drops gear but
pays NO exp/gold, so `orderWavesByRewardCap` sinks capped waves to the
back of that account's rotation (learned caps come from the pages
themselves; `rewardCapLv` in `config/waves.json` can pin one). Dive
targets override the sink — a diver sent to a capped wave still reaches
its page (gear hunt).

### Swarm attack — tick mobs, set the damage, swarm them one by one

The checkbox swarm (Targets page → **Swarm attack** card, `POST /api/swarm`)
is the precise version of the fleet hunt: instead of a name keyword, you
tick the exact live mobs (by **mob id**) and type **how much damage each
account must deal to that mob type**. The coordinator holds the ordered
queue and drives the whole fleet through it ONE target at a time:

1. **Mob 1**: every account joins that mob id and keeps slashing until
   EACH account banked its quota (`per_account` mode — the default), or
   the fleet's COMBINED damage reaches the quota (`total` mode). Damage is
   banked live from `damage.php`'s `totaldmgdealt`, so a restart or a fresh
   cycle resumes mid-quota.
2. **Mob 2**: the queue advances only when every live account met its
   share — a member that has not joined yet blocks the advance for a grace
   window (staggered logins are normal) and an account gone offline past
   the activity window stops blocking (the fleet never stalls on a dead
   account).
3. A mob that DIES first (slain by the fleet or auto-died on the game's own
   timer) marks the target done — the queue moves on instead of stalling on
   an instance that can never take the remaining damage.
4. **Queue empty + auto-refill ON**: fresh live instances of the queued mob
   names are pulled off the bus (ids not already swarmed) and the hunt keeps
   going — mob ids churn every ~10 minutes, this is what keeps it alive.
5. **Dungeon mobs ride the same queue**: `{kind:"dungeon", name, quota}` —
   the guild-dungeon cycle then walks the floors and fights ONLY that mob
   type, capping each fight at the account's remaining quota, until every
   account's share is banked. The card's quick-pick chips list the dungeon
   mob types the fleet last saw down there.

The per-account progress bars, the queue table (attacking / queued / done /
mob died) and the timestamped log all live on the same card —
`GET /api/swarm` returns the same view for scripts. `DELETE /api/swarm`
freezes the queue. The built-in fetcher never swarms (its stamina belongs
to fetching); everyone else joins automatically. State persists per site
(`data/swarm.json`) — a restart resumes the job.

**Stamina awareness (stats.php).** Every swarm engagement is gated on the
account's REAL bar, refreshed from `stats.php`'s top bar (the same page
carries `#stats-state` — attack stat, MAX_STAMINA — which the forecast also
reads): a dry account drinks the stamina-potion ladder once; if the ladder
is empty too, the account SITS OUT the cycle — it reports `OUT_OF_STAMINA`
and makes **no join POST at all** — while the rest of the fleet fights on.
Its row on the swarm card shows the live bar (`⚡ 512 / 1,370`) or
**"no stamina — waiting for a refill"**, and the account re-joins by itself
the moment the bar regenerates (or a potion lands in the bag).

**Damage forecast (the "View Monster Stats" modal).** Every battle page
embeds the mob's full stat block (`#monsterStatsModal`: Attack, Defense,
Pet Defense, Equipment Defense, Element, Element Rate, Rewards Up To LV,
and the Crit Rate / Crit Damage / Final Damage / Passive Damage
resistances) — `monster-stats.js` parses it straight off the zero-stamina
battle view and caches it per mob TYPE (30 min TTL). Together with the
account's own loadout (`stats.php` attack stat + the equipped PvE Attack
Set's ATK sum from `inventory.php` + the equipped pet team's ATK sum from
`pets.php` — `loadout.js`) it feeds the game's exact damage formula
(`damage.js`):

    base = (225 + max(30, equipAtk − EQ DEF)·20 + max(30, petAtk − PET DEF)·20
            + 1000·max(30, attackStat − DEF)^0.25) · stamina_cost
    elemental = ((playerRate − monsterRate) · 1500) · stamina_cost   (countered → rate ×2)

Each swarm engagement logs **≈dmg/hit** and **≈hits left** before the first
stamina point is spent, and publishes the forecast + the mob's stats to the
panel: the current-target line shows the chips (`≈13,105 dmg/hit · ≈77
hit(s) left · DEF 3 · EQ 1 · PET 1 · None · rewards ≤ LV 300`, with
**element countered ×2** when the account's element counters the mob's),
the queue rows carry a compact `≈X/hit` chip, and `GET /api/monster-stats?
site=&mobId=` serves the whole block plus a fleet-average forecast — the
swarm editor renders it live next to each ticked mob type so the quota
input gets an honest "≈N hit(s)/account" hint before you arm the swarm.

**Live calibration (2026-11-22).** The whole chain was validated against the
live game with one account (`scripts/live-swarm-calibrate.js`): login →
auto-farm verified OFF → `fetchLoadout` (equipAtk 92 · petAtk 437 ·
attackStat 5 · stamina 545/545) → 34 alive Grakthar wave-1 Goblin
Skirmishers → the modal parsed fresh (DEF 3 · EQ DEF 1 · PET DEF 1 · None ·
rewards ≤ LV 300) → forecast **13,105 dmg/hit** → two real 1-stamina hits →
`totaldmgdealt` accumulated 13,987 → 27,974 with the stamina echo 544 → 543.
**Per-hit accuracy: 107%** — inside the ±30% band crits/variance live in, so
the quota math ("≈77 hit(s) for 1M") is trustworthy. All THREE farm accounts
calibrated the same way (the strong account lands 1.4-2.1× the base forecast —
crits only ever push actual hits ABOVE the formula, the safe direction for
quota planning).

**Live fleet swarm (2026-11-22).** The full dress rehearsal
(`scripts/live-fleet-swarm-run.js`) booted the real server, added the fleet
through the panel API and armed a per-account **60,000 dmg** swarm on a fresh
Grakthar wave-1 Goblin Skirmisher: diver-2 banked **135,583/60,000**
(FINISHED — its dry 4-stamina bar was refilled by the potion ladder to
2,928/2,930 mid-run) and diver-3 banked **66,432/60,000** (FINISHED) —
queue **complete**, 202,015 damage banked. The element half went live the
same day: `fetchLoadout` now reads the PvE set's combined element + rate
from stats.php's `#elements-pve` dialog ("FIRE · 25%"), and equip-best grew
a counter preference (`damage.counterOf(mob)` → prefer counter-element gear;
the swarm's current-target intel drives it automatically, or pass
`preferElement` to `POST /api/equip`).

**Live 3-account swarm + sequential queue (2026-11-23).**
(`scripts/live-fleet-swarm-3accounts.js`) The farm booted **fetcherless**
(no `ADMIN_GAME_*`) so nothing was reserved: all three accounts joined the
roster, and the swarm armed a **two-mob queue** — two fresh live Goblin
Skirmisher instances off the same wave page, per-account quota 30,000 each.
Every account FINISHED its own quota on BOTH targets, the coordinator's
cursor visibly advanced target 1 → target 2 the moment the last account
banked, and the queue closed **complete**: diver-1 49,829 + 41,961,
diver-2 54,233 + 54,233 (deterministic one-shot), diver-3 44,288 + 44,288 —
**288,832 total damage banked**, per-account stamina tracked live
(⚡399/545 · ⚡2886/2930 · ⚡451/1400). All checks green: `complete=true
bothTargetsDone=true fleetOf3=true queueAdvanced=true perAccountLedger=true`.
The per-hit damage proved deterministic for the same account/mob pair
(identical `totaldmgdealt` steps per hit), so a quota's "≈N hits" hint is
exact, not an average.

**Fetcherless mode (found by the 3-account run).** The built-in fetcher is
now OPTIONAL: leave `ADMIN_GAME_EMAIL` empty and no hidden account is seeded
— every visible account fights, swarms and hunts, the swarm roster carries
the whole fleet, and the site's scout sweeps pages through the oldest healthy
worker's session (the fallback already existed for fetcher re-logins; it
simply became permanent). Set the env pair to reserve one account for
read-only sweeps instead. Also NaN-proofed `sleep`/`jitter` in `util.js`: a
missing config value can no longer reach `setTimeout(NaN)` — the wait
degrades to ~0 instead of a Node warning.

**Live hardening (found by the dress rehearsal, all regression-tested).**
Four real bugs surfaced only against the live game:

1. `waveCombat` now REJOINS on the game's "You were removed due to
   inactivity. Please rejoin the battle." (the old code backed off blind for
   up to 20 minutes while the swarm waited on a silent account).
2. An armed swarm PREEMPTS normal rounds mid-fight (`shouldAbort` hook in
   `waveCombat`/`waveFarmRound`/`diveBusRound`): a 100M-cap Olympus wall
   fight no longer holds an account 20+ minutes while the queue waits.
3. The reaction stamina farm walks the WHOLE manga catalog when every
   chapter already answers "already" (never "added") — 10-30+ silent
   minutes per cycle. Batch semantics kept (`batch` = new reactions) but
   engagements are capped (4× batch) and a 90 s wall-clock budget bounds
   the sweep (`stopped: time_budget`).
4. `parseBattleView` matched the embedded JS error catalog ("Monster is
   already dead.") and flagged EVERY alive mob dead — every wave round
   skipped everything ("reads dead — skipped"). Dead markers now match
   visible page text only (script/style bodies stripped first).

**Stamina-gate hardening (found by the swarm flake test, 2026-11-23).** The
swarm's dry-account gate trusted any page's folded stamina bar within 5 s —
but a bar that rode along on an unrelated page can be seconds behind the
game's truth, so a dry account could occasionally slip a join POST past the
gate before the first damage.php answered "not enough stamina". `staminaNow`
grew an `authoritative` mode: only folds whose SOURCE is the game's own live
number count as fresh — stats.php itself or the damage.php stamina echo —
anything else forces one stats.php GET. The swarm gate uses it; every other
stamina read keeps its cheap window. Reproduced as a ~1-in-3 flake in
`swarm-test.js` before the fix, 4/4 green after.

### Fleet hunt — "attack all Troll Ravager"

One order for the whole farm: **Targets page → Fleet hunt card** (or
`POST /api/hunt {mob, site?}`). The SAME dive targets land on EVERY
account of the site at once — live, not at next restart:

1. The store rows are patched (the order survives a restart) and every
   running worker re-arms its target list on the spot.
2. Each account's **next cycle bus-dives**: it takes the scout's latest
   sweep (the "Live mobs" table on the same page), attacks every mob whose
   name matches the order — join (`user_join_battle.php`) + slash
   (`damage.php`), fighting to death, whatever wave page the mob lives on —
   then keeps hunting the same targets on their pinned wave pages, round
   after round, until the order is stood down.
3. `DELETE /api/hunt` (or the card's **Stop** button) stands the fleet
   down. Per-account targets stay editable as before (the accounts page).

`DIVE_BUS=0` turns step 2 off (divers then only hunt on their pinned
wave pages). The account row shows the fleet volleys as `dive 8/1t (+3
fleet) → Grakthar · wave 2`.

### Gear keep-up — equip-best + blacksmith

Waves drop gear and crafting materials; two automatic rounds keep every
account dressed and armed (both skip the built-in fetcher):

- **Equip-best** (`equip.js`, every 15 min, `EQUIP_AUTO=0` to disable):
  `inventory.php?set=attack` is parsed — equipped slots (the label's
  ATK/DEF spans) and bag items (`data-inv-id/typee/atk/def`). Every slot
  whose bag item scores strictly higher (`atk×EQUIP_ATK_WEIGHT +
  def×EQUIP_DEF_WEIGHT`, default 3:1 — kill speed pays the EXP/hour) is
  re-worn via `inventory_ajax.php` `equip_item inv_id=<bag> slot_id=0
  set=attack` — the game's own equip-modal call, `OK` on success. Rings
  land in ring slot 1; the round is idempotent (second run wears nothing).
- **Blacksmith** (`blacksmith.js`, every 30 min, `BLACKSMITH_CRAFT=0` to
  disable): all three gates are swept (`blacksmith.php?gate=3|5|0` —
  Grakthar / Olympus / Events) and every recipe the page itself marks
  craftable (Forge button enabled, every material req green) is forged
  `POST craft_item.php {recipe_id}`, strongest attack first, capped by
  `BLACKSMITH_MAX_CRAFTS` per sweep. Forging clears the equip cooldown so
  the new gear is worn immediately.

Panel buttons: **POST /api/equip** and **POST /api/blacksmith/craft** run
a round on one account NOW (`accountId` optional — default oldest
healthy). The account row shows `3eq · 2forged` once the rounds yield.

### Merchant potions — stamina, HP and mana

The potion buy-all is now multi-kind (`POTION_BUY_KINDS`, default
`stamina,hp,mana`): the merchant sweep keeps every consumable the hunt
ladders drink in stock — Small/Full/Adventurer Stamina, Full HP Potion,
Mana Potion S — with one running gold budget (stamina first, then hp,
mana; each line is re-aimed at what the previous line left, so a pricey
HP row can never starve the cheaper mana row of gold). Eggs, treats,
gem rows and gear are never auto-bought.

## The missed-game sweep — claims, guild contracts, event dailies & the battle pass

The game has whole reward systems the old farm never touched. They were
scouted live (the dashboard links them all) and are now part of the cycle —
every one of them pure profit, nothing spent (the class picker in
"Classes" rides the same hook family: one cheap GET per login, and a POST
only when the account is level ≥ 200, classless and allowed to).

**Achievements + collections (`CLAIMS`, on by default).**
`achievements.php` and `collections.php` render `.card[data-ach-id]` /
`.card[data-col-id]` blocks whose Claim button is enabled only once the
achievement/collection is earned; the pages' own inline scripts POST
`achievements_claim.php {ach_id, csrf}` / `collections_claim.php
{collection_id, csrf}`. The engine parses the two pages (chunked at card
boundaries so a neighbour's button can never leak), claims only the ENABLED
buttons — disabled ones are unearned progress — and audits the yield
(gold/gems on achievements, PERMANENT stat points on collections). Claims
are earned slowly, so the sweep runs once per `CLAIMS_COOLDOWN_MS`
(default 2 h) and a second pass over a fresh page claims nothing at zero
cost.

**Adventurers Guild contracts (`GUILD_QUESTS`, on by default).**
`adventurers_guild.php` lists contracts — kill/skill/gather — with ONE
active slot ("Finish or abandon your current quest first."). The loop:

- finished contract (Progress: X / Y met, `finishQuest(ID)` rendered) →
  `POST adventurers_finish_quest.php` → AP + gold collected;
- active gather contract with rendered Donate buttons (the game only
  renders them for items you own) → `POST adventurers_donate_gather.php
  {quest_id, item_id}` — opt-in via `QUESTS_DONATE=1` because the items
  are consumed;
- idle → accept the next contract (`POST adventurers_accept_quest.php`),
  KILL/SKILL contracts first: the normal wave farming completes them in
  the background (each manual slash registers), so the engine just turns
  them in and picks the next. Gather contracts are the last resort — they
  stall the slot until the items drop.

Kill contracts carry a per-kill minimum damage (`Kill 5 monster(s) ·
Monster: Lizardman Shadowclaw · min 3m dmg`) — the parsed requirement arms
the **per-mob damage floor** for that monster: wave fights continue past
the loot gate until the mob dies with ≥ 3m of this account's damage on it,
so the kills actually count (see "Per-mob damage floors").

**The quest hunt (`QUESTS_HUNT`, on by default).** A kill contract only
progresses on pages that actually host the contract monster — out of the
box the round-robin may take a while to land on one. The hunt closes that:
every parsed wave page feeds a persistent `data/hunt-map.json` (mob name →
hosting wave — names survive the wave resets, ids do not); while a kill
contract is armed the wave picker drives the worker STRAIGHT to the pinned
wave (quest mobs attack first), and an unknown monster is probed page by
page (one unvisited page per round, offset per worker) until some page
reveals it. Live-verified 2026-11: the Shadowclaw contract pins
`gate=3&wave=5` out of the 13-page registry. Hunt rounds still farm every
eligible mob on the pinned page, so the stamina always buys EXP even after
the kill count is satisfied but not yet turned in. The panel's account row
shows the hunt state (`hunt:Gate 1 · wave 2` pinned / `hunt:probe N`), and
`QUESTS_HUNT=0` returns to plain round-robin.

The state lives on the panel row: accepted/finished/donated counters plus
the last round report and the armed requirement (`quests.questReq`).

**Event daily contracts (`EVENT_DAILIES`, on by default).**
The dashboard links live events (`/event_page.php?event=N` — the Dragon
Realm at scout time); each event page embeds its JSON panel API base
(`"panelUrl":"...&map=M"`). `panel=sanctuary:board` is the Fountain
Noticeboard: TEN daily contracts, rewards reset at server midnight
(Dragon Silver / Gold / Dragoncall Coins):

- **Hunting / damage contracts** — progress accrues from MANUAL hits and
  MANUAL loots (the board says so verbatim). The engine's wave farming is
  exactly that (it never uses the game's auto-farm), and the kill-loot
  hook covers the loot side. The board is read each round for the progress
  feed and audited (`event_board`), so the panel can show 3 / 15 style
  progress per contract.
- **Dispatch contracts** — a roleplay choice rendered as
  `{action:'sc_daily', hidden:{quest, day, answer}}` forms. One choice per
  quest per day completes it; every option is valid. The engine submits
  the first form (deduped per quest id) to the panel URL with the board's
  csrf, exactly like the game's own sanctuary.js, and the hidden fields
  are re-read every run — a new day re-arms automatically.
- **Supply contracts** — "Deliver 5 X. Items are consumed on turn-in." —
  never auto-turned-in (spends items, needs an inventory mapping).

No event live, or the event page ships no panel API? The round no-ops
cleanly.

**Battle Pass (`BATTLE_PASS`, on by default).**
`battle_pass.php` runs seasons. Between seasons the page answers "No
Battle Pass season available. Come back later." and the round is a
clean no-op (live-verified). When a season is live — typically TWO daily
quests that reset with the season day:

- **"Spend 500 Stamina"** — fills from the engine's own farming (every
  manual Slash costs stamina); nothing extra to do, the board is read for
  the progress feed.
- **Mob-family damage quest** — "Deal 300,000 damage to Lizard / Sea mobs"
  (the family rotates per season). While it is open the engine steers
  farming toward it: waves REMEMBERED to host matching mobs go first in
  the round-robin (`orderWaves`: match > unknown > non-matching, stable
  inside each bucket), and within a wave page the matching mobs are
  attacked FIRST (every hit then feeds both the farm and the quest;
  non-matching mobs still farm so stamina always buys EXP). The keywords
  come from a curated lizard/sea lexicon PLUS any other noun in the
  objective — an unseen season family still gets picked up. A
  stamina-only quest arms nothing.
- **Claims** — the page's own claim-btn convention (the same pattern as
  achievements/collections: enabled `claim-btn` once ready, disabled
  while not). csrf, the POST endpoint and the body field are read off the
  page's own inline script, so quests and tier rewards all claim without
  anything hard-coded. Nothing is spent — battle pass claims are pure
  rewards (`battle_pass_claim` audit).

The knob set: `BATTLE_PASS=0` disables the module,
`BATTLE_PASS_WAVE_PRIORITY=0` keeps farming strictly round-robin,
`BATTLE_PASS_COOLDOWN_MS` (default 30 min) spaces the page reads.

**Deliberately NOT automated** (scouted, rejected on purpose): Weekly
Treasury deals and the PVP soul shop (they spend GEMS / Player Souls),
the blacksmith, legendary forge and decraft (they consume crafted gear),
power-crystal equip/upgrade and pet feeding/ascension (inventory surgery
with real costs), PVP matchmake (interactive season ladder), mail and
chat (social), weekly leaderboard + colosseum (rewards pay out on their
own).

## The game endpoints this speaks (live-traffic contract)

These are the exact requests the game makes — the same ones the extension
logs as `Grabbed Fetch URL` / `Grabbed Link` — and the engine reproduces them
byte-for-byte (form-encoded POSTs, per-account cookie jar):

| Action | Request | Body / Notes |
|---|---|---|
| gate map | `GET /gates.php` · `GET /olympus.php` | the gate index and the Gate 2 hub — reference pages for the wave registry (default = all of them, see `config/waves.json`) |
| read a wave | `GET /active_wave.php?gate=X&wave=Y` | every gate/wave pair has its own page with different mobs/values. Parsed two ways: `data-monster-id` rows (boss discovery) and the mob **cards** — `battle.php?id=` links, `<h3>` name, `You: 12,345` (this account's damage on that mob), `HP 0 /` / `Defeated` dead flags, `.boss-card` exclusion |
| join a fight | `POST /user_join_battle.php` | `id` + `monster_id` + `user_id` — the live wave client sends all three; "already dead / can't attack" responses mark the target dead |
| do damage (boss) | `POST /damage.php` | `monster_id` + `skill_id` + `stamina_cost` — JSON with `status`, `totaldmgdealt`, stamina, marks |
| do damage (wave) | `POST /damage.php` | `monster_id`, `skill_id=0`, `stamina_cost=1` — the 1-stamina Slash. The response's `totaldmgdealt`, `stamina` and `hp {value,max,percent}` drive the wave loop: `hp.value <= 0` → slain, `stamina` folds into the vitals, "too quickly / cooldown" → wait 1 s and retry, "Not enough stamina" → potion ladder or round stop |
| just view (no damage) | `GET /battle.php?id={id}` | the link you get when you open a battle without attacking. Zero stamina. The page carries the monster's dead flag, **your HP** (`#pHpText`), the **battleDrawer** potion cards and the mob's **loot table** ("DMG req: X" per item). Used five ways: scout pre-verification before broadcasting; the `view` link in the panel; `GET /api/battle/:id`; the combat loop's HP watch; the per-mob loot-gate cap read |
| use an item (potion) | `POST /use_item.php` | **`inv_id=<id>` — one field**, exactly what the game's own drawer sends when you press Use. The id is read per-account from the drawer's `data-inv` (it changes per account; `data-item` is the stable item type: 30 small / 35 full / 251 large / 359 adventurer / 108 full HP / 162 mana S / 163 mana L). Fallback for accounts that never opened a battle page: the `inventory.php` slot-box scan |
| free timed heal | `POST /user_heal_potion.php` | `user_id` — the "Ready in 00:32:14" heal button; used as the heal fallback when no HP potion is stocked |
| boss spawn timers | wave pages' `.auto-summon-card` rows | `data-alive` / `data-next-ts` (set once per spawn, held through the whole cycle — the Boss Tracker's life-transition marker) + `.auto-summon-sub` "Auto-die: 48h" + `.auto-join-btn` battle link. The boss's own battle page embeds `AUTO_DIE_CFG = { nextDieMs }` — the only honest remaining-life clock. Remaining ≤ 24h = phase 2 (hit it), > 24h = phase 1 (skip) |
| corpse sweep | wave pages with cookies `show_dead_bosses_only=1`, `hide_dead_monsters=0` | dead rows carry `data-userdmg` (your damage — ≤ 0 means nothing to loot), a **Loot** button and `data-expire`. Collection: `POST /loot.php { monster_id, user_id, instance_id: '0' }` → `{ status:'success', rewards:{exp,gold}, items[] }`. The 👁️ "Show unclaimed kills" state is `hide_dead_monsters=0` + `show_dead_bosses_only=0` (setting ONLY the boss-only cookie hides every dead non-boss mob — the sweep sets both explicitly) |
| pvp season | `GET /pvp.php` (season title, `Leaderboard: #N`, `Tier:` / `Tokens:` info-pills, `Season Ended: Solo matchmaking is closed.` when over) · `POST /pvp_matchmake.php { ladder: 'solo'\|'party' }` → `{ status:'success', redirect }` · `POST /pvp_refill.php { refill: 1, ladder }` (never auto-spent — refills cost gems) | matchmake buttons (`.js-matchmake data-ladder=…`) only render while the season is open — the engine matchmakes ONLY then, follows ONE redirect and classifies the battle page (the interactive fight engine needs one live open-season sample; the season is CLOSED 2026-11-22, season 4 ended, Tier Novice · 30 tokens · #3,262) |
| reaction stamina farm | `GET /chaptered.php?manga=…&chapter=…` → `GET /comments_api.php?chapterid=N…` → `POST /postreaction.php` | the chapter widget carries `data-chapter="N"`; comments_api answers `{ viewer: { csrf } }`; the reaction POST is `chapterid` + `reaction` + `useruid` + `csrf` → `added` / `updated`. The `reacted_chap_<id>` cookie (1 year) is the game's own skip marker — replayed in the account's jar |
| potion shop buy-all | `GET /merchant.php` → `POST /merchant_buy.php { merch_id, qty }` · `GET /adventurers_guild.php` → `POST /adventurers_shop_buy.php { shop_item_id }` (one per call) · `GET /olympus_damon_buy.php?action=state` → `POST { offer, qty }` | merchant cards carry `data-merch-id/-currency/-price/-maxq/-bought` and gold sits in `#goldBalance`; guild rows carry `buyShopItem(<id>)` + "N / M remaining"; Damon's JSON offers carry `weekly_limit / bought / remaining`. Gem prices, unlimited stock and sold-out rows are never bulk-bought. Multi-kind: stamina, hp ("Full Hp Potion") and mana ("Mana Potion S") rows are stocked per `POTION_BUY_KINDS`, each bought within the running gold budget |
| equip-best | `GET /inventory.php?set=attack` (equipped rows: `.slot-box` + `unequipItem(<slotId>)` + the label's ATK/DEF spans · bag rows: `.slot-box[data-equip="1"]` with `data-inv-id/-typee/-atk/-def`) → `POST /inventory_ajax.php { action:'equip_item', inv_id, slot_id: '0', set: 'attack' }` → body `OK` | `slot_id=0` is exactly the game's own equip modal call for non-ring items — the server places the item in the set's natural slot for its type (rings → slot 1). Response anything but `OK` = refused (the modal `alert()` branch). Unequip is `action:'unequip_item'` + `slot_id` |
| blacksmith craft | `GET /blacksmith.php?gate=3\|5\|0` (Grakthar / Olympus / Events; per-gate recipe cards: `info-btn` `data-name/-attack/-defense`, `.reqs` rows `title="material"` + `.qty good\|bad` `have/need`, Forge `form action="craft_item.php"` with `recipe_id`) → `POST /craft_item.php { recipe_id }` | the Forge button is `disabled` and reqs show `.qty bad` while materials are missing — the engine only POSTs recipes the page itself calls craftable (never a half-met recipe); the reply is a full page read for forged/error markers |
| fleet hunt | scout sweep rows (the "Live mobs" bus) → `POST /user_join_battle.php` + `POST /damage.php` per matching mob id | `POST /api/hunt {mob}` arms every account with the same dive targets live; each account's next cycle bus-dives the matching live ids (join + slash to death, any wave) and keeps hunting them on their pinned wave pages |
| guild dungeon | `GET /guild_dungeon.php` → `GET /guild_dungeon_instance.php?id=N` → `GET /guild_dungeon_location.php?instance_id=X&location_id=Y` → `POST /dungeon_join_battle.php { instance_id, dgmid }` → `POST /damage.php { instance_id, dgmid, skill_id, stamina_cost }` → `POST /dungeon_loot.php { instance_id, dgmid, user_id }` | the hub is the source of truth for open instances and embeds the session's guild (`guildId = N;`); instance ids are PER-OPEN (they churn every open — one dungeon of each kind open per day, the run persists until cleared or closed by the leader/vice) and the ACTIVE grid carries one template card per kind (`dungeon_info.php?id=` 1 easy · 2 hard · 3 poly/cube layout + the current instance id, "Only leader/vice can open." when none is); ended grids list the uncleared/failed runs ("Awaiting leader/vice to loot") — skipped; floors list `.mon` cards with `battle.php?...dgmid=` links (state pills, ATK/DEF/`EXP/dmg` statpills, a healbox with the revive countdown while the player is down); `damage.php` answers the same JSON shape as waves and the same message branches ("you are dead" → heal, "already dead" → next, "not joined" → re-join once, "Not enough stamina" → potion ladder) |
| guild identity | `GET /guild_dash.php` | the game IGNORES `?guild_id=` — it always answers the caller's own guild; `<h1>` = `[ TAG ] Guild Name`, page script carries `guildId = N;`. The verification source for the panel's guild code |
| claims sweep | `GET /achievements.php` · `POST /achievements_claim.php { ach_id, csrf }` · `GET /collections.php` · `POST /collections_claim.php { collection_id, csrf }` | `.card[data-ach-id]` / `.card[data-col-id]` blocks with a Claim button; only ENABLED buttons (earned) are claimed — `disabled` = unearned progress; the csrf rides in each page's own inline claim script (`{ach_id:id,csrf:"…"}`); replies are `{status:'success'\|'error', message}` |
| guild contracts | `GET /adventurers_guild.php` (`.quest-row` cards) · `POST /adventurers_accept_quest.php { quest_id }` · `POST /adventurers_finish_quest.php { quest_id }` · `POST /adventurers_donate_gather.php { quest_id, item_id }` | rows carry `acceptQuest(ID)` / `finishQuest(ID)` / `giveUpQuest(ID)` / `donateGatherItem(qid, itemId)` onclicks, an Objective line (`Kill 5 monster(s) · Monster: X · min 3m dmg`, `Gather 2x item(s) · Item: …`), Rank tags and `Progress: X / Y` on the active row; the ACTIVE row's objective is REWRITTEN by the game (`Kill 5 monster(s) · min 3,000,000 dmg` — monster name dropped), so the row's description prose ("Kill 5 Lizardman Shadowclaws while dealing at least 3m damage to each") restores it; ONE active slot — the game refuses a second accept with "Finish or abandon your current quest first."; kill/skill contracts complete from normal farming with the per-mob damage floor armed (see "Per-mob damage floors") |
| event daily contracts | dashboard event links → `GET /event_page.php?event=N` (embeds `"panelUrl":"…&map=M"`) → `GET {panelUrl}&panel=sanctuary:board` (JSON cards + csrf + revision) → `POST {panelUrl} { action:'sc_daily', quest, day, answer, revision, request, csrf }` | the Fountain Noticeboard: ten daily contracts reset at server midnight; hunting/damage contracts progress from manual hits + manual loots (the kill-loot hook feeds them); dispatch cards render choice forms — ONE first-choice submit per quest per day, deduped; the POST carries the board's `revision` + a random 32-byte hex `request` idempotency key (the game's own sanctuary.js body; missing either → "Invalid action. Reload this page."); supply contracts ("items consumed on turn-in") are never auto-turned-in; no panel API or no live event = clean no-op |
| battle pass | `GET /battle_pass.php` ("No Battle Pass season available." between seasons) → quest/tier rows (`claim-btn`, disabled until ready, csrf + claim endpoint + body field in the page's own script) → `POST battle_pass_claim.php { quest_id, csrf }` | seasons ship two dailies: "Spend 500 Stamina" (fills from normal farming) and a mob-family damage quest ("Deal 300,000 damage to Lizard/Sea mobs" — family rotates per season); while it is open the wave picker prefers waves remembered to host matching mobs and the matching mobs are attacked first on each page (keywords: curated lizard/sea lexicon + the objective's other nouns); every ready claim (quests + tiers) fires; season off/over = clean no-op |
| classes | `GET /classes.php` (classless: four `.class-strip` cards + `choose_class_id` confirm forms · bound: "You are already bound to a class." + "Your class: X") · `POST /classes.php { choose_class_id }` → 303 → bound | every base class requires **Character level ≥ 200**; the classless page's picker ranks Warrior/Mage/Hunter/Cleric by their PvE skills (Fireball 4m + 10% ATK per 200 stamina tops the table — see "Classes"); the engine binds the optimal class right after login when allowed, verifies off the re-read page, and never touches accounts whose policy is `off`; `class_skill_tree.php` shows the bound tree (skills unlock with Adv. points, not farm actions) |
| class skill tree | `GET /class_skill_tree.php` (embeds `window.SkillTreeData = [{id, name, unlock_level, adv_points_req, stamina_cost, flat_stam_dmg, owned, level, used_times, max_level, next_rule:{adv_points, times_used, flat_damage_stamina}}, …]` + `window.SkillTreeConfig = {ajaxUrl, className, totalSkills, ownedCount, advExp, classPassive}` — the config object carries a trailing `// ← NEW` comment, so never JSON.parse it raw) · `POST /class_skill_tree.php { action:'unlock_skill'\|'level_up', skill_node_id }` → `{ok, level, used_times, adv_points_left}` \| `{ok:false, error}` | the tree only exists once a class is bound (classless sessions get "choose a class first"); Adv. Points come from the guild contracts ("100 AP • 10,000 Gold") — quests earn, the tree spends; the engine unlocks the PvE damage skills first (Mage **Fireball unlocks FREE** — 0 AP), levels them by damage-per-stamina, then everything else, while the wallet stays above `SKILL_TREE_RESERVE`; honored gates: `unlock_level` (char level — Mana Shield asks 200), `next_rule.times_used` (mastery — the skill needs battle uses first) and the server's own refusals (rank floors — recorded, never fatal); see "Classes" below |
| the cube (Polyhedral Crucible) | `GET /guild_dungeon_cube.php?instance_id=X` (`const STATE = {…}`: faces · nodes · `linked_location_id` floors) → `POST /guild_dungeon_cube_action.php { action:'enter_node', instance_id, node_id, face_key }` → `{ ok, redirect: 'guild_dungeon_location.php?…', state }` → the normal location/loot flow | cube instances REDIRECT the regular instance page here; combat nodes carry `linked_location_id` (11–13 mob rooms, 14 the Apex gate) and the server maps enter_node → that floor; a weekly guild leaderboard (`GUILD_ID / CLEARS / TOTAL_CLEAR_SECONDS`) rides in the same STATE blob |

## Vitals & auto-potions

The engine watches each account's stamina and HP without extra requests:

- **Stamina** — every HTML page the game returns carries the top bar
  (`<span id="stamina_span">8</span> / 7,190`); one regex pass over the
  response captures it. The dashboard shows `cur/max` per account.
- **HP** — battle pages carry the player card (`#pHpText`, e.g.
  `376,500 / 358,250 HP`). Refreshed during fights by the combat loop's
  view-only HP watch (on join + every 30 hits) and by scout peeks.
- **Potions** — the battleDrawer cards (`data-inv` / `data-item` /
  `data-name` / `data-max`) are parsed wherever they appear, so every drink
  uses the per-account inventory row id and respects quantities.

Auto-actions (all configurable, all skippable via env):

| Trigger | Action | Env |
|---|---|---|
| `stamina < 50` (absolute) | drink stamina ladder: small → large → full | `STAMINA_POTION_BELOW`, `POTION_SLOT_NAMES` |
| skipped while `EXP >= 80%` | a level-up would waste the refill (extension's AI rule, ported) | — |
| `HP% < 30` | HP potion, else the free timed heal | `HP_POTION_BELOW_PCT`, `HP_POTION_NAMES` |
| `mana <= 0` (bar used up) | mana ladder: Mana Potion S → L (Veyra auto-mana; `MANA_POTION_BELOW=0` means only when the bar is empty) | `MANA_POTION_BELOW`, `MANA_POTION_NAMES` |
| stamina ladder came up dry | potion-shop buy-all sweep (merchant → guild → Damon), once per cooldown | `POTION_BUY`, `POTION_BUY_COOLDOWN_MS` |
| between drinks | minimum spacing so one low reading can't chain-drink | `POTION_COOLDOWN_MS` |

The dashboard's vitals block per account now shows stamina, HP **and mana**
(`#pManaText` off the battle pages).

## Per-mob damage caps — the "DMG req:" loot gate

Every mob's battle page lists its drop table with a damage requirement per
item (`DMG req: 70,000`), and the numbers differ per gate and per wave. Past
the top requirement extra damage buys nothing — it is pure stamina waste.
The engine therefore stops attacking each mob at exactly that mob's best-loot
threshold (`MOB_CAP_MODE=auto`, the default):

1. **Live loot gate** — before hitting an unknown mob the worker views its
   battle page (free, zero stamina) and reads the highest `DMG req:`. That
   value is learned per mob NAME and persisted to `data/loot-caps.json`, so
   it survives restarts and is shared by every account.
2. **Measured tables** (`server/loot.js`) — the full per-mob breakdown from
   the console loot-scanner run (all 90 mobs: Gate 1 70,000 → Zeus/Apollo
   mains 8,000,000,000) plus per-wave defaults (Gate 1 w1 70,000 · w2 3.5M ·
   w3 7M · Olympus w1 30M · god gates 100M). Used when the battle page shows
   no loot table.
3. **`MOB_DAMAGE_CAP`** — last-resort cap (default 70,000) for mobs that
   appear nowhere else.

Set `MOB_CAP_MODE=fixed` to ignore loot entirely and stop every mob at
`MOB_DAMAGE_CAP` (the original `TARGET_DAMAGE` behaviour of the live wave
script). `/api/waves` reports the current mode and how many caps have been
learned so far; each wave round's audit event records the caps it applied.

## Per-mob damage floors — the guild contracts' "min 3m dmg" rule

The kill contracts on `adventurers_guild.php` do not just ask for kills —
they demand **your own damage on each kill**: the board reads
`Kill 5 monster(s) · Monster: Lizardman Shadowclaw · min 3m dmg`, and a kill
only COUNTS when the mob died with at least 3,000,000 of YOUR damage on it.
A mob stopped at its 70k loot gate can therefore never complete the contract.

The engine closes that gap automatically:

1. **The active contract is parsed** (`server/quests.js`) — objective line
   for available rows, the description prose for the active row (the game
   rewrites it to `Kill 5 monster(s) · min 3,000,000 dmg` and drops the
   monster name once accepted). The worker arms
   `questReq = {monster, minDamage, kills}` for the contract's monster.
2. **Wave fights go past the loot gate** (`server/combat.js`) — a floored
   mob ignores its cap and fights to DEATH (the kill is the point);
   matching mobs are also attacked first and the wave picker remembers
   which pages carry the contract monster, so the contract completes on the
   right waves.
3. **Dungeon fights** (`server/dungeons.js`) — mobs whose MAX HP is below
   their floor are skipped before any stamina is spent (their kill could
   never count), and every fight reports `floorMet`.

You can set your own per-mob damage amounts on top (this is "users set a
specific amount of damage for each mob"):

| Env | Meaning |
|---|---|
| `MOB_MIN_DAMAGE` | one floor for **every** mob (0 = off, default) |
| `MOB_MIN_DAMAGE_JSON` | per-name overrides, matched against the lowercase mob name — **last matching rule wins**, `"*"` is the catch-all |

```bash
MOB_MIN_DAMAGE=0
# every lizard takes 3m of your damage, troll ravagers 2.5m, everything else untouched:
MOB_MIN_DAMAGE_JSON={"*":0,"lizardman":"3m","troll ravager":2500000}
```

Values accept plain numbers or k/m/b shorthand (`3m` → 3,000,000). The
active contract's own rule always adds on top (max of both). The panel's
account row shows the armed contract (`quests.questReq`) so you can see
which monster is currently floored and by how much.

## Classes — every account farms; the engine binds the optimal class

The farm works for **every account regardless of class and level** — nothing
in the cycle requires a class. Classless accounts (new friends' accounts,
low-level accounts) farm waves, join bosses, loot corpses, run dungeons and
complete every daily sweep exactly like everyone else; the Adventurers Guild
even accepts their contracts. What changes with a class is REACH: the kill
contracts' "min 3m dmg" floors need big hits, and the class passives scale
every attack — so the engine closes the gap on its own:

1. **Detection** (`server/classes.js`) — every login re-reads `classes.php`.
   Classless pages render four base-class strips + a `choose_class_id`
   confirm form; bound pages answer "You are already bound to a class." +
   "Your class: Mage". The level comes from the same top bar the EXP poll
   uses (`gtb-level`).
2. **The optimal pick** — ranked by PvE skill damage per 200-stamina cast
   (the unit wave farming spends), live-verified from the class previews:

   | Class | Passive | PvE skill (per 200 stamina) | Verdict |
   |---|---|---|---|
   | **Mage** | +25% ATK, −50% DEF | **Fireball 4,000,000 + 10% ATK** | **default** — one cast covers a 3m floor |
   | Hunter | +20% crit dmg, −30% DEF | Back Stab 2,700,000 + 30% def pen | solid second |
   | Warrior | +30% HP | Ironclad Strike 1,000,000 | tanky, weakest PvE |
   | Cleric | auto-heal 0.03% max HP / stamina | none (PvP support only) | never auto-picked |

3. **The binding** — once an account is **level ≥ 200** (every base class's
   requirement) and still classless, the engine POSTs
   `choose_class_id=N` to `classes.php` and re-reads the page to confirm the
   binding. Under 200 the picker waits and retries on later rounds —
   classless accounts simply farm until they level up.
4. **You stay in charge** — the game's choice is permanent, so overrides
   are explicit:

   | Setting | Meaning |
   |---|---|
   | `CLASS_AUTO_PICK` | env default for every account: `auto` (Mage) · `mage` · `warrior` · `hunter` · `cleric` · `off` |
   | per-account `classPick` | the panel's add-account form, the account row's own selector on the accounts page (`PATCH /api/accounts/:id {classPick}` — applies to RUNNING workers immediately), or `"classPick"` in `POST /api/accounts` — wins over the env for that account |
   | `CLASS_MIN_LEVEL` | the level gate (default 200, the game's own requirement) |
   | `off` | always respected — the engine never POSTs for that account |

The panel's account table shows the bound class (or `waits · lvl N / 200`,
`off`, `classless`), the status API exposes `classInfo`
(`{currentClass, level, action, lastReport}`) and every pick lands in the
audit log (`class_picked`). The built-in fetcher never picks a class.

**The class skill tree (`SKILL_TREE`, on by default).** Once an account is
bound, its `class_skill_tree.php` is upgraded automatically every
`SKILL_TREE_COOLDOWN_MS`:

1. **Read** — the page embeds `window.SkillTreeData` (every skill: unlock
   cost, char-level gate, damage per stamina cast, owned/level/used_times,
   the next level's AP cost and mastery rule) and `window.SkillTreeConfig`
   (the Adv. Point wallet `advExp`). Classless sessions have no tree — a
   clean no-op.
2. **Spend, damage first** — the PvE damage skills unlock first (Mage
   **Fireball unlocks FREE**: `adv_points_req: 0`, so a freshly classed
   account gets its damage skill at a 0 AP wallet — live-verified), then
   they level by damage-per-stamina (Fireball lv 2 = 30,000 flat + 10% ATK
   for 2,000 AP), then the utility/PvP skills while points remain.
3. **Gates honored before every POST** — `unlock_level` (Mana Shield wants
   character level 200 — skipped without wasting a request),
   `next_rule.times_used` (mastery: the skill must be USED in battle before
   the next level), `SKILL_TREE_RESERVE` (AP kept banked, default 0) and
   `SKILL_TREE_MAX_SPENDS` (POST cap per round, default 10). Server
   refusals (rank floors) are recorded and never fatal.

| Setting | Meaning |
|---|---|
| `SKILL_TREE` | `0` disables the whole module |
| `SKILL_TREE_COOLDOWN_MS` | round spacing per account (default 30 min; AP income is quest-paced) |
| `SKILL_TREE_RESERVE` | Adv. Points kept unspent (default 0) |
| `SKILL_TREE_MAX_SPENDS` | max unlock/level POSTs per round (default 10) |

The panel's class cell shows the tree progress (`tree · Mage · 240 AP ·
+1 skill(s) · 2 level-up(s)`), the status API exposes `skillTree`
(`{className, points, unlocked, leveled, lastReport}`) and every spend
lands in the audit log (`skill_tree_upgrade`). The quests ↔ tree loop:
guild contracts pay AP, the tree spends it on damage.

**Guild-contract accepts while classless.** Kill contracts need a class —
without one there is no damage skill and a `min 3m dmg` floor can never be
met, so the contract slot would stall forever. While `classInfo` reports
the account classless, new accepts are HELD (turn-ins and donations still
run, gather contracts included); the class picker binds one at level 200+
and accepts resume on their own.

## Cloudflare — the curl transport

2026-11: the game sits behind a Cloudflare managed challenge that TLS-
fingerprint Node's fetch — every request earns a 403 `Just a moment…` page
no matter which User-Agent it wears. **curl's TLS stack passes the same
edge untouched** (verified live: login 303, hub 200, floors 200), so the
engine runs its requests through one curl subprocess per call
(`server/curl-transport.js`):

- same headers, same per-account cookie jar (every Set-Cookie is folded
  back exactly like the fetch path), `redirect: 'manual'` semantics kept;
- **async spawn** — the event loop keeps spinning while curl runs, so the
  panel never stalls on a game request;
- `CURL_TRANSPORT=auto` (default) picks curl when the binary exists and
  falls back to fetch otherwise; `curl` forces it; `fetch` keeps the old
  path (for self-proxied setups);
- a challenge page is never mistaken for a logged-in session: `auth.js`
  matches the real challenge markers (`Just a moment…` title,
  `window._cf_chl_opt`) and login fails with a readable message instead of
  scraping challenge HTML all night. Note that every page loads
  `/cdn-cgi/challenge-platform/scripts/jsd/…` in the background — that is
  ambient Cloudflare plumbing, not a challenge.

If your host has no curl binary, install it (`apt install curl`) or the
engine silently uses fetch and may earn challenges again.

## Stat allocation — the `allocatePlan` port

The console control loop `await allocatePlan({ attack: 0, defense: 0,
stamina: 44444 })` is now a server feature (`server/stats.js`). It speaks the
same contract the game's stats page shows:

- `GET stats.php` → the page embeds `#stats-state`, JSON with the csrf token,
  a `view` version counter and the user object (`STAT_POINTS`, `ATTACK`,
  `DEFENSE`, `MAX_STAMINA`). Workers already poll this page for the EXP
  read-out, so banked points land in the dashboard for free (the **Points**
  column: `9,556 · A10 D454 S7190`).
- `POST stats_ajax.php` → `action=allocate`, `stat=attack|defense|stamina`,
  `amount=<chunk>`, `csrf`, `view`, `request_id` (24 hex, fresh per attempt).
  **The server only accepts amounts of 100 / 50 / 5 / 1** — the engine
  decomposes any plan into exactly those chunks (44444 → 456 posts, 250 ms
  apart).
- **Self-heal** — a stale csrf/view bounces `409`; the engine re-fetches
  fresh tokens from `stats.php` and retries the same chunk (≤ 2 retries,
  exactly like the console script).

Three ways to drive it:

1. **Panel** — section 5 “Stat allocation”: pick an account (or oldest
   healthy), type the amounts, press **Allocate**.
2. **API** — `POST /api/stats/allocate {"plan":{"stamina":44444}}` (or with
   `accountId`, or plan-less to use `STAT_PLAN`), `GET /api/stats` for the
   snapshot.
3. **Automatic** — `STAT_PLAN=stamina=44444` + `STAT_AUTO_ALLOCATE=1`: every
   worker runs the plan **once per session**, as soon as its stats.php poll
   sees enough banked `STAT_POINTS`. Not enough points yet = keep waiting
   (re-checked each poll); a hard failure is marked done for the session so
   the engine never thrashes. Every run (manual or auto) is audited as
   `stat_allocation` with the plan and the applied chunks.

Refusals are reported, never guessed: `empty_plan`, `insufficient_points`
(with the banked total), `stat_failed` (with the per-chunk error) — and a
refused plan sends **zero** `stats_ajax.php` posts.

### Targets mode (the Veyra auto stat allocator)

Instead of fixed amounts, `server/stats.js` also ports the Veyra allocator's
**"spend everything up to targets"** loop (`allocateTargets`): attack →
defense → stamina, one chunk at a time, re-reading the server truth after
every chunk and picking the largest of [100, 50, 5, 1] that fits
`min(remaining need, banked points)`. It stops cleanly on `targets_reached`
or `points_drained` — both healthy outcomes.

- `STAT_TARGETS=attack=1000,defense=1000,stamina=1000` sets the goals.
- `STAT_TARGETS_AUTO=1` makes every worker keep spending fresh level-up
  points toward them (re-armed on every EXP poll; cheap — it only fires when
  unspent points exist).
- API: `POST /api/stats/allocate {"targets":{"attack":500}}`.
- The `#stats-state` `core` shape the redesigned stats page uses
  (`{core:{points,attack,defense,stamina}}`) is normalized to the `user`
  shape automatically.

## Boss spawn timers & the 48h phase gate (Boss Tracker port)

Boss wave pages carry one `.auto-summon-card` per scheduled boss, and each
48h auto-die boss's battle page embeds its true death clock
(`AUTO_DIE_CFG = { nextDieMs }`). The scout folds the peek views into the
cards — zero extra requests — and publishes:

- `GET /api/spawns` — every card: alive, next-spawn timestamp, remaining
  life, phase, "You:" damage (the tracker's drawer, server-side).
- Each published boss target carries `spawnPhase`. With the default
  `BOSS_PHASE_GATE=1`, workers **skip phase-1 bosses** (more than
  `BOSS_PHASE2_HOURS` = 24h of life left — damage there doesn't count) and
  hit the moment the boss enters phase 2. Life-transition detection rides on
  `data-next-ts`, exactly like the tracker's rules.

## Knowing an account is still there (and alive)

The panel (section 3) is the answer to "is my account still running?" — every
row is one account, refreshed every 15 s:

| Signal | Meaning |
|---|---|
| `running` chip (green) | logged in, cycle working — this is the healthy state |
| `logging_in` / `starting` | staggered startup or a re-login in progress — normal |
| `logged_out` (amber) | the game ended that session (expired, kicked, captcha'd, banned). The worker re-logins automatically after the cooldown — if it stays amber for hours, the password likely changed or the account is banned |
| `error` (red) | last action failed; read the **Last error** cell |
| **EXP gained · %** | proof of life from `stats.php`: EXP earned since the worker started + current bar. If this freezes while the chip is green, something is wrong upstream |
| **Points** | banked stat points + current attributes from the same page's `#stats-state` (`9,556 · A10 D454 S7190`), refreshed with every EXP poll; grows the dashboard's view of allocations too |
| **HP · Stam** | the account's last seen vitals: `376.5k/358.3k · 8/7.2k`. Stamina comes from the top bar on any page fetch; HP from battle pages. When HP or stamina run low, the auto-potion policy kicks in (see “Vitals & auto-potions”) |
| **Last action** | age of the last successful game request. `quiet` (red, 10+ min) means the worker is stuck or cooling down → press **relogin** |
| **Now** | what it is doing this second: a wave label (`wave: Olympus · Hermes gate`), a boss name, `auto-farm`, or `idle`. The Boss runs column also shows wave mobs hit as `Nw` |

Accounts themselves are **persistent**: credentials live encrypted in
`data/accounts.enc` and every worker is relaunched from that store at boot —
Wispbyte restarts and redeploys do not lose accounts. A row disappears only
when someone removes it (audited as `account_removed`).

Every state change is also appended to `data/audit.log` (`login_ok`,
`login_fail`, `session_lost`, `account_degraded`, `boss_result`,
`stat_allocation`, …). Set `DISCORD_WEBHOOK_URL` and the bad ones
(`login_fail`, `session_lost`, `account_degraded`) are pushed to a Discord
channel in real time — that is how friends find out without watching the
panel.

Emergency stop: the **farm: ON/PAUSED** button (`POST /api/farm`) holds every
worker in a harmless keep-alive loop without logging anyone out.

## The fetcher — a built-in admin account (hidden, fixed, optional)

**When `ADMIN_GAME_EMAIL` is set: one account fetches for everyone, and it is
not one of the user accounts.**
At boot the engine seeds its own game account into the encrypted store —
`ADMIN_GAME_EMAIL` / `ADMIN_GAME_PASSWORD` (no defaults: the login lives only
in the host's private environment panel) — and that account is permanently
THE fetcher:

- **Hidden from users.** It never appears in `/api/status`, `/api/stats`, the
  account list, or the stored count; the panel only shows an anonymous
  "built-in fetcher" line. Its row carries `role:'admin'` + `hidden:true` and
  is sealed with the same AES-256-GCM as every other password.
- **Fixed.** `POST /api/scout` with any other account (or a clear request)
  answers 403; the fetcher account cannot be removed (403); adding an account
  with the fetcher's email is refused (reserved). The designation persists to
  `data/farm.json` and is re-pinned on every boot.
- **It fetches AND joins the battles it broadcasts.** It logs in FIRST
  (everyone else waits on its sweeps) and runs the same combat engine — boss
  targets to their caps plus precision wave rounds over the whole gate/wave
  registry — but nothing else: no dungeon runs, no corpse sweeps, no reaction
  farm, no shop sweeps. Fetching is its job; fighting its own broadcasts is
  its fight.
- If it is mid-relogin or cooling down, the sweep temporarily borrows the
  oldest healthy account instead — targets keep flowing — and the fetcher
  resumes automatically once it is `running` again.

**When `ADMIN_GAME_EMAIL` is empty/unset: fetcherless mode (2026-11-23).** No
hidden account is seeded at all — `seedAdminAccount` returns null, the swarm
roster carries every visible account, and the scout's client getter (which
always had the "borrow the oldest healthy worker" fallback for fetcher
re-logins) simply rides the workers permanently. Choose this when every game
account you own should fight; choose the seeded fetcher when you would rather
spend one account's stamina on read-only page sweeps. The boot banner says
which mode is live (`fetcher=…` / `fetcher=NONE — every account fights…`).

Before broadcasting a matched boss, the scout also peeks its
`battle.php?id={id}` page (view-only, no damage): a boss that reads dead
there is not published that sweep, so farmers never waste a join on a corpse.
A failed peek never blocks publication — the join response is still the
final guard.

**The bus is rebuilt from every sweep (freshness fix, 2026-11).** Mobs on
the wave pages churn hard — each instance auto-dies on its own timer
(`data-expire`, read straight off the card and published as `expiresAt`) or
dies to players, and a NEW instance with a NEW mob id takes its slot. The
scout therefore publishes the union of ONE full sweep as a replacement set:
a mob that vanished from its page leaves the bus on the next sweep instead
of haunting farmers with dead ids for 2 h. Waves whose fetch failed that
sweep are carried over (never wiped by a partial outage), and first-seen
`foundAt` survives replacements so the panel's "Found" age stays honest.

**The boss catalogue was live-verified and corrected (2026-11).** Six of
the Olympus "main" bosses had stale names the game no longer uses, so the
scout could never match them: Hermes is *Divine Herald of the Endless Road*
(not "Fleet Duelist of the Crossroads"), Poseidon's domain boss is
*Sovereign of the Drowned Steps* (not "Duelist of the Crushing Tide"), Ares
is *Sovereign of the Red Bastion*, Athena is *Sovereign of the Ivory War
Library*, Hera is *Sovereign of the Crown Court*, and Zeus is *Sovereign of
the Storm Throne*. `config/bosses.json`, the core catalogue in
`server/bosses.js` and the measured loot-gate table in `server/loot.js` all
carry the live names now. The targets page also lists **every live mob** the
sweep sees (not just bosses) with mob id, wave, found-age, dies-in countdown
and a view-only battle link — "no boss targets" now reads as exactly that:
the boss table's empty state says whether the sweep ran and simply found no
catalogue boss alive.

Add or edit bosses in `config/bosses.json` (`key` must exist in the cap
table in `server/bosses.js`), then restart the server.

## Running 5–20 accounts

- **Memory**: each account is a cookie jar + async loop — tens of KB. 20
  accounts sit comfortably inside the 512 MB free tier; the HTTP work is
  idle most of the time by design.
- **Login ramp**: `LOGIN_STAGGER_MS` (default 45 s) spaces sign-ins so 20
  accounts don't hit the game from one IP at once — the last account starts
  ~15 min after boot. That ramp is a feature, not a bug.
- **Request pressure**: 20 accounts × cycles every 20–60 s is a lot of
  traffic from one datacenter IP. Keep `JITTER_SCALE` ≥ 1.0, consider
  `CYCLE_MIN_MS`/`CYCLE_MAX_MS` on the high side, and don't lower
  `HIT_DELAY_MS`.
- **Dashboard**: the table scrolls; every row keeps its own status, EXP and
  last-action age.
- **Scaling the scout**: the fetcher sweeps ALL configured waves every
  `SCOUT_INTERVAL_MS` on one session — with the full 12-page gate registry
  that is one pass over `gates.php`'s map per interval; if you add more
  waves, raise `SCOUT_INTERVAL_MS` so one account isn't paging the game
  non-stop.

## Security model

- Passwords: AES-256-GCM (scrypt-derived key from `AIO_SECRET_KEY`), stored
  only as `{iv, tag, ct}` in `data/accounts.enc`. Plaintext never hits disk,
  logs, or API responses.
- Emails: stored for login; **masked** (`a***z@domain.tld`) in every API
  response.
- Admin token: constant-time compared; simple 120 req/min per-IP limiter.
- Audit: `data/audit.log` (JSONL, append-only) — adds/removes/logins/boss
  results. No credentials, ever.
- CORS: set `ALLOWED_ORIGINS=https://your-front.vercel.app` once your panel
  is deployed (any origin is allowed until then; the token still gates all).

## Risk notes (read once, then own it)

- **Automation almost certainly breaks the game's terms of service.** All
  accounts in this farm can be banned. You chose "friends too": you are the
  custodian of their credentials — lose `AIO_SECRET_KEY` or leak
  `ADMIN_PASSWORD` (or a friend's login) and that is on you. Revoke accounts you no longer run.
- All traffic leaves from **one datacenter IP**. Keep `JITTER_SCALE` at 1.0
  or higher, logins staggered, and don't max every knob "fast".
- Never set `FAST_TEST=1` on a real deployment.

## Local test (no game traffic)

`node test/run-test.js` boots a mock game implementing the full protocol and
runs the engine end-to-end: token gate, encrypted store, masked API, worker
login, boss FINISHED path, scout discovery + dead-row filtering, parallel
worker, audit, relogin, revoke — plus protocol-fidelity checks that assert
the exact wire formats (the `inv_id`-only `use_item.php` body, battleDrawer
potion parsing with per-account inv ids, ladder order + empty-slot skip,
`battle.php?id=` HP/dead/loot parsing, stamina vitals in `/api/status`, view
links in `/api/targets`) and the precision wave engine (gate registry,
`gates.php`/`olympus.php`, card parsing with boss-card exclusion, 3-field
join, 1-stamina slashes, live "DMG req:" loot-gate caps + learned-cap
persistence, `MOB_CAP_MODE` auto/fixed, "You:" resume, dead refusal,
empty-stamina halt + potion refill, auto-farm off) — the stat-allocation
engine (`#stats-state` parsing, `[100,50,5,1]` decomposition, 409 self-heal
re-sync, per-chunk wire format, worker auto-run once per session,
`/api/stats/allocate` + `/api/stats` + targets mode) — and every ported
upload feature: auto-summon cards + 48h phase gate + `/api/spawns`, the
reaction stamina farm (manga discovery, comments_api csrf, `postreaction.php`
`added`, `reacted_chap_<id>` cookie dedupe, batch caps), the potion-shop
buy-all (merchant/guild/Damon wire formats, gold/points budgets, gem skip,
`/api/shop/stamina`), the corpse sweep (`show_dead_bosses_only` view,
`data-userdmg` gate, `loot.php instance_id='0'`, loot-to-level-up, worker
sweeps near level-up), the guild dungeon farm (hub → instance → floors →
`dungeon_join_battle.php` → 1-stamina Slashes → `dungeon_loot.php`,
per-worker rounds) and mana vitals + the mana potion ladder.
`node test/dailies-test.js` covers the missed-game sweep: claim parsing +
sweep idempotence (disabled buttons never touched), the guild contract loop
(kill-first accepts, one-slot refusal, finish + AP payout, gather donation
opt-in), the event daily contracts (dashboard discovery, panelUrl decode,
board progress feed, one dispatch submit per quest per day, no
double-submit), the manual kill-loot hook (off = no loot POST, on =
every SLAIN looted with the exact Loot-button request shape) and the
battle pass (no-season no-op, season parse, hint keywords + needs, wave
memory ordering, tier claim, quest-mobs-first attack order, farming feeds
the dailies, claim idempotence, season-over no-op). All five
suites run with `npm test`.

## The scripts this engine was ported from

Every module maps to real captured traffic from your userscripts/extensions
(the redesign UI was ignored — only the network behaviour was ported):

| Source upload | What was taken | Where it lives |
|---|---|---|
| All_In_OneUI v443 (extension) | login/CSRF, wave discovery, boss combat, PVP solver, smart looting | `auth.js`, `combat.js`, `loot.js`, `bosses.js` |
| live `allocatePlan` console script | fixed-plan stat allocation | `stats.js` (`allocatePlan`) |
| **Veyra Dashboard Redesign** | auto stat allocator (targets mode), auto heal + auto mana (`#pManaText`, mana ladder), stamina buy-all (merchant/guild/Damon), dead-boss corpse sweep, spawn timers, reaction farm | `stats.js` (`allocateTargets`), `combat.js` (`drinkManaPotion`), `shop.js`, `corpses.js`, `spawns.js`, `reactions.js` |
| **Veyra Stamina Farm** | manga/chapter discovery, `comments_api.php` csrf handshake, `postreaction.php` contract, `reacted_chap_<id>` cookies, daily caps + no-gain stop | `reactions.js` |
| **Boss Tracker** | `.auto-summon-card` parsing, `data-next-ts` life transitions, `AUTO_DIE_CFG.nextDieMs` phase detection, phase-1 damage exemption | `spawns.js`, `scout.js`, `workers.js` (gate) |
| **DungeonCleaner** | dungeon hub/instance/floor discovery, `.mon` `dgmid` cards, join/damage/loot contract, message branches, loot-dead-first order | `dungeons.js` |
| **Monster Quick Loot (workablecollector)** | `loot.php` corpse collection + retry/backoff and auth-error semantics | `corpses.js` |
| **LevelUp Looter Standalone** | dead-loot `dead_page` pagination (`.batch-loot-card` pager), `dgmid` in the wave loot body, EXP Cap / EXP-DMG stat blocks + best-EXP-first looting, skippable loot failures, autoloot stamina threshold, named dungeon cards + rosters (easy/hard/poly), joined/looted pill parsing, `#yourDamageValue` boss damage + BOSS_STATS expected-EXP ranking, post-level-up auto-battle potion-cap raise | `corpses.js`, `dungeons.js`, `shop.js` (`raiseAutoBattlePotionCap`), `waves.js` (event waves) |

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| `login rejected` in status | wrong password row → fix via re-add (same email updates the row) or `POST /api/accounts/:id/relogin` after correcting |
| `scout error: no logged-in account available yet` | normal until the first worker finishes its staggered login |
| Status `logged_out` flapping | game session expiry — fine; cooldown re-login handles it |
| 401 from the panel | wrong username/password, or the session expired (restarts clear sessions) — sign in again |
| Boss never attacked | its `key` has `c:false` for that level group, or the scout hasn't matched the name — check `/api/targets` and the `name` spelling in `config/bosses.json` |
| `logged_out` for a long time | password changed or account banned — verify the login manually, then re-add (same email updates the row) |
| EXP gained stuck at 0 | farm paused, or no targets for that level group — check the farm badge and `/api/targets` |
| Out of stamina but no potion drunk | the ladder matches the battleDrawer names — check `POTION_SLOT_NAMES` (default `small stamina potion,large stamina potion,full stamina potion`). Also skipped while EXP >= 80%, and at most one drink per `POTION_COOLDOWN_MS` |
| HP never shown for an account | HP only appears on battle pages — it fills in after the account's next fight / HP watch tick; stamina should always show once any page was fetched |
| Wrong peek result from `/api/battle/:id` | the peek borrows the fetcher's session — if no account is `running` it returns 409; check `/api/status` first |
| Wave rounds attack nothing (`0 mobs`) | every card on that page reads dead or already at its damage cap — check the page in a browser; lower `MOB_DAMAGE_CAP`, set `MOB_CAP_MODE=fixed`, or add waves via `WAVE_PAGES` / `config/waves.json` |
| Workers stuck on one gate | that's the round-robin by design (one page per cycle); more pages are covered as cycles pass — shrink `CYCLE_MIN_MS`/`CYCLE_MAX_MS` or trim `config/waves.json` to the gates you care about |
| `damage.php` answers "auto farm is on" | the game's own auto-farm is ON for this account (fresh sign-ups ship with it ON). With the default `AUTO_FARM_FIX=1` the worker PAUSES it itself — `auto_farm_status.php` read → the Auto Farm card's own `auto_farm_actions.php action=toggle&enabled=0` → verified by a second read → `auto_farm_disabled` audited — and resumes hunting (live-verified 2026-11: after the pause the same join+slash chain landed 13,987-damage hits). It also re-checks at every fresh login, so all accounts start hunting, not 400-ing. If the hint still shows, the toggle could not be confirmed (rare) — pause it once on the wave page's Auto Farm card |
| Wrong account is sweeping the waves | designated fetcher re-logining (temporary fallback) or not designated — press `fetcher` on the right row; check `scoutAccount` in `/api/status` |
| `stat_allocation` audit says `insufficient_points` | the plan is bigger than the banked `STAT_POINTS` — in auto mode the worker retries next poll once points accumulate; manual runs return the banked total in the report |
| Allocation runs but points barely move | each chunk is 100/50/5/1 — a 44,444 plan is 456 posts spaced 250 ms apart (~2 min); that is the game's own rate, not a stall |
| 409 on every chunk | the session's stats token expired mid-plan — the engine re-syncs from `stats.php` automatically (2 retries per chunk); repeated failures mean the session died → `relogin` |
| Everything too slow/fast | `JITTER_SCALE`, `HIT_DELAY_MS`, `CYCLE_MIN_MS`/`MAX` |

## File map

```
server/
  index.js      boot: store → bus → workers → scout → API
  config.js     env parsing (see .env.example)
  jar.js        per-account cookie jar (the "container")
  game.js       HTTP client: cookies, form posts, CSRF extraction, pacing,
                passive vitals (stamina top bar, #pHpText, #pManaText)
  curl-transport.js  the curl subprocess transport (Cloudflare passes curl's
                TLS, not Node's fetch) — same jar semantics, async spawn
  auth.js       ported CSRF login/logout/isLoggedIn/getUserId/level +
                Cloudflare challenge-page detection
  store.js      AES-256-GCM credential store + audit log
  bus.js        shared target bus (targets.json; carries spawn phases)
  bosses.js     boss catalogue + level-group caps (port of presets)
  waves.js      gate/wave registry (Gate 1 + Olympus; env/file overridable)
  combat.js     ported combat: discovery, probe→optimal, phase-2 PVP, heal,
                precision wave rounds, mana potion ladder, AUTO_DIE_CFG read
  stats.js      stat allocation: allocatePlan (fixed) + allocateTargets
                (Veyra targets loop), core-shape normalization
  reactions.js  reaction stamina farm (postreaction.php, veyra_stamina_farm)
  shop.js       potion-shop buy-all (merchant / guild / Damon's)
  equip.js      equip-best: inventory.php parse + strictly-better re-wears
                (inventory_ajax.php equip_item — the game's own modal call)
  blacksmith.js craft round: all gates swept, craftable recipes forged
                (craft_item.php recipe_id), strongest attack first
  corpses.js    dead-boss corpse sweep (dead_page pagination, dgmid loot body,
                EXP Cap ordering, loot-to-level-up)
  shop.js       potion-shop buy-all (merchant / guild / Damon's) + the
                auto-battle potion-cap raise (POTION_CAP_RAISE)
  spawns.js     auto-summon cards + 48h phase math (Boss Tracker)
  dungeons.js   guild dungeon farm (DungeonCleaner) — per-open instance ids,
                kind ids, ended-run skip, cube STATE flow
  guilds.js     guild auto-join ("accept guilds") — registry search, join/apply
                forms, dash-verified membership
  claims.js     achievements + collections claim sweep (enabled-buttons only)
  quests.js     Adventurers Guild contracts (accept → farm → finish → donate)
                + requirement parsing ("min 3m dmg" → per-mob damage floor)
  events.js     event discovery + sanctuary daily board (progress feed +
                sc_daily dispatch submits)
  battlepass.js battle pass seasons: daily quest parse, wave steering
                (match > unknown > nomatch), claim sweep, no-season no-op
  classes.js    classes.php: state detection (classed/classless), the
                optimal-pick catalog (Mage default — PvE damage per stamina),
                ensureClass binding round with the level-200 gate
  skilltree.js  class_skill_tree.php: SkillTreeData/Config parsing (the
                config carries a trailing // comment), the damage-first
                spend plan (unlock → level by dmg/stamina), unlock_skill /
                level_up POSTs, char-level + mastery + reserve gates
  hunt.js       the quest hunt map (data/hunt-map.json): mob name → hosting
                wave, includes-matching, persisted across restarts; the
                worker's picker pins the armed contract's monster's wave;
                seeded from config/mobs.json (the live-scraped wave
                rosters) — seeds are probe hints, never hard pins, and a
                dry round demotes a stale pin (self-healing steering)
  divers.js     the Divers engine: per-account dive targets (parse/match),
                event-wave discovery + the persistent event registry,
                reward-cap wave ordering ("Rewards Up To LV X" steering)
  pvp.js        PvP season ladder (Divers pillar 3): pvp.php board parse
                (season/rank/tier/tokens), open-season matchmake + battle
                redirect classification, closed-season no-op
  corpses.js    corpse collecting: the wave page's "👁️ Show unclaimed kills"
                state (hide_dead_monsters=0 + show_dead_bosses_only=0),
                lootable-corpse parse (data-userdmg + Loot button +
                data-expire), loot.php collection, best-EXP-first ordering
  scout.js      wave sweep → bus publisher (+ spawn phases, /api/spawns)
  workers.js    worker manager (parallel containers, stagger, relogin) and
                the cycle wiring: potions/mana, buy-all, corpse sweep,
                reaction batches, dungeon cycles, phase gate, kill loots,
                claims / guild contracts / event dailies / battle pass /
                PvP sweeps, dive steering + pin self-heal, in-game
                auto-farm PAUSE (auto_farm_status/actions), class pick
                (login-time + per-cycle, throttled), skill tree upgrades,
                quest hunt wave steering, classless accept-hold
  api.js        admin API (zero deps) + serves the panel from web/
config/bosses.json   boss list you can edit
config/waves.json    gate/wave registry you can edit (WAVE_PAGES env wins)
config/mobs.json     wave rosters (mob + boss names per registry page) —
                     the hunt map's seed, live-scraped 2026-11
web/                 static multi-page panel (served by the farm itself,
                     or deployable on Vercel/GitHub Pages as-is):
  index.html         sign-in (only page without the nav bar)
  dashboard.html     overview: tiles, farm switch, live rows, target preview
  accounts.html      add account, full management table, potion-shop sweep
  targets.html       shared bus (live boss targets + the LIVE MOBS list —
                     every mob the pages show, with id/wave/dies-in/view
                     link + filter) + boss spawn timers + wave registry
  stats.html         stat allocation (plan + targets modes), per-account stats
  users.html         owner-only friend login management
  css/base.css       the whole look (game palette, cards, tables, toasts)
  js/common.js       shared core: session, api client, header/nav, toasts,
                     polling that pauses on hidden tabs
  js/login|dashboard|accounts|targets|stats|users.js   one script per page
test/                mock game + end-to-end test suites
data/                created at runtime: accounts.enc, audit.log, targets.json
```
