// i18n.js — which language MAXGEAR speaks, and every word it says.
//
// Two languages, bokmål first (hub CLAUDE.md §2, "Two languages, Norwegian
// first"). With nothing stored the game speaks Norwegian whatever the browser
// prefers — no navigator.language sniffing; an English speaker is one tap away
// on the menu's SPRÅK row.
//
// THE KEY IS THE HUB'S, NOT OURS: `arcade.lang.v1`, holding "nb" or "en" and
// nothing else. A language is a fact about the player rather than the cabinet,
// so someone who chose English in one game has chosen it in all of them. It
// can never be renamed and never carry anything else (§6).
//
// THE SHAPE, same in every arcade game:
//   t(key, ...args)   current language, else English, else the key itself —
//                     warning once per missing key in the console.
//   getLang()         'nb' | 'en'
//   setLang(lang)     validates, stores, sets <html lang>, repaints the static
//                     markup, then dispatches `arcade:lang` on document with the
//                     language as detail. main.js hears that and has ui.js and
//                     effects.js repaint everything they built themselves.
//   paintStatic(root) [data-i18n] -> textContent, [data-i18n-html] -> innerHTML
//                     (our own strings, never player input), [data-i18n-label]
//                     -> aria-label AND title, and aria-pressed on every
//                     [data-lang] choice button.
//
// A value may be a function, because a language is not a template with blanks
// in it: "+1 NIVÅ" / "+2 NIVÅER", word order in "NIVÅ 2 KLART".
//
// WHAT IS NOT HERE: the name MAXGEAR, the manifest, console output, storage
// keys. screen.js keeps its own two-word table because it must stay
// self-contained (see its header).
//
// Imports nothing, and every DOM touch is guarded, so upgrades.js and
// campaign.js can import it and still load headless.

const LANG_KEY = 'arcade.lang.v1';
const hasDoc = typeof document !== 'undefined' && !!document && !!document.documentElement;

function initial() {
  try {
    const saved = localStorage.getItem(LANG_KEY);
    if (saved === 'nb' || saved === 'en') return saved;
  } catch (e) {
    // No storage (private mode, blocked site data): the default applies.
  }
  return 'nb';
}

let lang = initial();
// index.html's inline head script already did this before first paint; doing
// it again here costs nothing and covers a page that lost that script.
if (hasDoc) document.documentElement.lang = lang;

const STRINGS = {
  nb: {
    // ---- title -----------------------------------------------------------
    'title.tagline': 'Reklamen var falsk. Dette er ekte.',
    'title.play': '▶  SPILL',
    'title.upgrades': '⚙  OPPGRADERINGER',
    'title.hint': 'Mellomrom / klikk / trykk for å starte  ·  Esc pause  ·  R start på nytt  ·  M lyd av/på',
    'update.ready': (v) => `⚙  NY VERSJON KLAR${v ? ` · ${v}` : ''}`,
    'update.busy': '⚙  OPPDATERER …',
    // Sentence case, no ◂ and no caps, unlike every other button here: the way
    // out is the one control that looks the same in every game in the hub
    // (CLAUDE.md §2, "One button"), and ui.js draws the shared back arrow in
    // front of these words rather than a glyph of MAXGEAR's own.
    'exit.arcade': 'Tilbake til arkaden',
    'exit.app': 'Lukk',
    'exit.refused': 'Lukk fanen selv',

    // ---- corner ----------------------------------------------------------
    'corner.menu': 'Meny',
    'corner.menuTitle': 'Meny (Esc)',
    'corner.mute': 'Skru av lyden',
    'corner.unmute': 'Skru på lyden',

    // ---- the menu --------------------------------------------------------
    'menu.paused': 'PAUSE',
    'menu.settings': 'INNSTILLINGER',
    'menu.resume': 'FORTSETT',
    'menu.quit': 'AVSLUTT RUNDEN',
    'menu.back': 'TILBAKE',
    'sound.cap': 'LYD',
    'sound.music': 'MUSIKK',
    'sound.sfx': 'EFFEKTER',
    'lang.cap': 'SPRÅK',

    // ---- HUD -------------------------------------------------------------
    'hud.score': 'POENG',
    'hud.steer': '<b>DRA</b> ELLER <b>A</b>/<b>D</b> FOR Å STYRE &nbsp;·&nbsp; DU SKYTER AUTOMATISK',
    'num.DMG': 'SKADE',
    'num.ROF': 'TAKT',
    'num.SHOTS': 'SKUDD',
    'num.HULL': 'SKROG',

    // ---- the gate legend -------------------------------------------------
    'legend.shootDefuse': '⌖ SKYT DEN UFARLIG · ',
    'legend.defuseTight': '⌖ SKYT · ',
    'legend.shoot': '⌖ SKYT: ',
    'unit.hp': 'HELSE',

    // ---- upgrades: names, short names, blurbs ----------------------------
    'track.damage': 'TUNGE SKUDD',
    'track.fireRate': 'BLÅSEBELG',
    'track.multishot': 'DELT LØP',
    'track.homing': 'GYROGRANAT',
    'track.lance': 'LANSE',
    'track.blast': 'KJELEBOMBE',
    'track.arc': 'TESLASPOLE',
    'track.burn': 'BRANNSKUDD',
    'track.frost': 'FROSTVENTIL',
    'track.crit': 'BLINKSKUDD',
    'track.saw': 'SVINGHJUL',
    'track.broadside': 'BREDSIDE',
    'track.shrapnel': 'SPLINTREGN',
    'track.squad': 'ESKORTE',
    'track.plating': 'PANSERPLATE',
    'track.aegis': 'SKJOLDSPOLE',
    'track.siphon': 'KONDENSATOR',
    'track.thrust': 'SKYVKRAFT',

    'short.damage': 'TUNG',
    'short.fireRate': 'BELG',
    'short.multishot': 'DELT',
    'short.homing': 'GYRO',
    'short.lance': 'LANSE',
    'short.blast': 'BOMBE',
    'short.arc': 'TESLA',
    'short.burn': 'BRANN',
    'short.frost': 'FROST',
    'short.crit': 'BLINK',
    'short.saw': 'HJUL',
    'short.broadside': 'BRED',
    'short.shrapnel': 'SPLINT',
    'short.squad': 'ESKORTE',
    'short.plating': 'PANSER',
    'short.aegis': 'SKJOLD',
    'short.siphon': 'DAMP',
    'short.thrust': 'FART',

    'blurb.damage': 'Tyngre granater. Hvert skudd treffer hardere — grunnmuren i ethvert oppsett.',
    'blurb.fireRate': 'Fyr under kjelen: kortere tid mellom hver salve. Gjør alt annet sterkere.',
    'blurb.multishot': 'Ekstra løp skyter side om side. Salven strammer seg inn av seg selv når den blir bredere.',
    'blurb.homing': 'Gyrogranater svinger mot nærmeste maskin. Slutter å bomme for deg.',
    'blurb.lance': 'Skuddene blir til nåler som går tvers GJENNOM fiender. LV5 går gjennom skjoldplater.',
    'blurb.blast': 'Granatene smeller når de treffer, og skader maskinene rundt. Større smell for hvert nivå.',
    'blurb.arc': 'Treff sender ut lyn som hopper fra maskin til maskin. Elsker store flokker.',
    'blurb.burn': 'Skuddene setter fyr på maskiner: skade over tid. Fra LV4 sprer brannen seg når de går i stykker.',
    'blurb.frost': 'Frostkuler bremser fiendens tannhjul — både farten OG angrepene. LV5 stopper fiender som stormer mot deg.',
    'blurb.crit': 'Sjanse for gylne fulltreffere som gjør stadig mer skade (opptil 3x).',
    'blurb.saw': 'Svinghjul av messing går rundt skroget og kverner alt de treffer. Fra LV3 stopper de fiendeskudd.',
    'blurb.broadside': 'Ekstra kanoner skyter til sidene og bakover. LV5 er en hel ring av jern.',
    'blurb.shrapnel': 'Maskiner sprenges i splinter når de går i stykker, og skader naboene sine.',
    'blurb.squad': 'Eskorteskip flyr rundt deg og skyter med deg på halv styrke — lettere granater, samme kanoner. De kan bli skutt ned, så de tar treff for deg.',
    'blurb.plating': 'Naglet panser: mer skrog, OG mindre skade fra LV3.',
    'blurb.aegis': 'Et skjold som lader seg opp igjen og tar et helt treff for deg. Fra LV3 støter det maskiner i nærheten.',
    'blurb.siphon': 'Fang dampen fra de falne: hver maskin du knuser, gir deg helse — men bare litt per sekund.',
    'blurb.thrust': 'Større motorer. Styr raskere, og unngå det andre må tåle.',

    'up.repair': 'REPARASJON',
    'up.surplus': 'BONUS',
    'up.rust': 'RUST',
    'up.breach': 'LEKKASJE',
    'up.tradeScattergun': 'HAGLE',
    'up.tradeGlassCannon': 'GLASSKANON',
    'up.tradeOverpressure': 'OVERTRYKK',

    'desc.levels': (n) => `${n > 0 ? '+' : ''}${n} ${Math.abs(n) === 1 ? 'NIVÅ' : 'NIVÅER'}`,
    'desc.heal': (p) => `HELER ${p}`,
    'desc.surplus': (p, s) => `HELER ${p} · +${s}`,
    'desc.hp': (p) => `-${p} HELSE`,
    'desc.defused': 'UFARLIG',
    'desc.noEffect': 'INGEN VIRKNING',

    // ---- the upgrades screen --------------------------------------------
    'up.title': 'OPPGRADERINGER',
    'up.tagline': 'Alle oppgraderingene i spillet — trykk på rutene for å se hvert nivå',
    'up.previewLevel': 'Vis nivå',
    'up.levelN': (n) => `Nivå ${n}`,
    'tier.1': 'FINNES FRA UTKANTEN (NIVÅ 1)',
    'tier.2': 'LÅSES OPP I STØPERIET (NIVÅ 2)',
    'tier.3': 'LÅSES OPP PÅ VERFTET (NIVÅ 3)',

    // ---- saves and difficulty -------------------------------------------
    'slots.title': 'VELG LAGRING',
    'slot.name': (i) => `PLASS ${i}`,
    'slot.empty': 'TOM — NYTT SPILL',
    'slot.cleared': 'ALLE NIVÅER KLARE ★',
    'slot.level': (n, of) => `NIVÅ ${n} / ${of}`,
    'slot.score': (s) => `POENG ${s}`,
    'slot.agoM': (m) => `${m} min siden`,
    'slot.agoH': (h) => `${h} t siden`,
    'slot.agoD': (d) => `${d} dager siden`,
    'slot.replay': 'SPILL FINALEN IGJEN →',
    'slot.resume': 'FORTSETT →',
    'slot.sure': '✕ SIKKER?',
    'slot.delete': 'Slett lagringen',
    'diff.title': 'HVOR VANSKELIG?',
    'diff.easy': 'LETT',
    'diff.medium': 'MIDDELS',
    'diff.hard': 'VANSKELIG',
    'diff.easy.blurb': 'En søndagstur. Snillere maskiner.',
    'diff.medium.blurb': 'Slik spillet er ment å spilles.',
    'diff.hard.blurb': 'Kjelene hyler. Ta med panser.',

    // ---- campaign --------------------------------------------------------
    'level.1': 'UTKANTEN',
    'level.2': 'STØPERIET',
    'level.3': 'VERFTET',
    'level.4': 'JERNVERKET',
    'act.0': 'TENNING',
    'act.1': 'TRYKK',
    'act.2': 'FULL GASS',
    'act.label': (id, flavour) => `NIVÅ ${id} · ${flavour}`,
    'boss.foreman': 'FORMANNEN',
    'boss.ironclad': 'JERNKOLOSSEN',

    // ---- level clear and the end screens --------------------------------
    'lc.heading': (n) => `NIVÅ ${n} KLART`,
    'lc.sub': (name, next) => `${name} er sikret · neste: ${next}`,
    'lc.notePick': 'VELG <b>2</b> OPPGRADERINGER DU VIL BEHOLDE — RESTEN BLIR SKRAP',
    'lc.noteAll': 'FÆRRE ENN TRE OPPGRADERINGER — ALT BLIR MED VIDERE',
    'lc.noteNone': 'INGEN OPPGRADERINGER Å TA MED — NY KJELE VENTER',
    'lc.saved': 'VALGET DITT LAGRES SAMMEN MED FREMGANGEN',
    'lc.continue': 'FORTSETT →',
    'stat.score': 'POENG',
    'stat.kills': 'KNUST',
    'stat.distance': 'AVSTAND',
    'grp.core': 'KJERNE',
    'grp.offense': 'ANGREP',
    'grp.defence': 'FORSVAR',
    'end.wrecked': 'ØDELAGT',
    'end.build': 'UTSTYRET DITT',
    'end.retry': '↻  START PÅ NYTT',
    'end.hint': 'R: start på nytt',
    'end.victory': 'JERNKOLOSSEN ER KNUST',
    'end.again': '↻  SPILL IGJEN',
    'end.campaign': (diff) => `HELE KAMPANJEN ER FULLFØRT · ${diff}`.trim(),

    // ---- words that float up out of the field ---------------------------
    'pop.shield': 'SKJOLD!',
    'pop.overdrive': 'TURBO!',
    'pop.steamburst': 'DAMPSMELL!',
    'pop.furious': 'SINT!',
    'pop.enraged': 'RASENDE!',
    'pop.phase2': 'FASE 2',
    'pop.shieldDown': 'SKJOLD BRUTT',
    'pop.allyDown': 'ESKORTE TAPT',
    'pop.aegis': 'SKJOLD',
    'pv.hull': (n) => `SKROG ${n}`,
    'pv.blocked': 'BLOKKERT',
  },

  en: {
    'title.tagline': 'The ad was fake. This one is real.',
    'title.play': '▶  PLAY',
    'title.upgrades': '⚙  UPGRADES',
    'title.hint': 'Space / click / tap to start  ·  Esc pause  ·  R restart  ·  M mute',
    'update.ready': (v) => `⚙  UPDATE READY${v ? ` · ${v}` : ''}`,
    'update.busy': '⚙  UPDATING…',
    'exit.arcade': 'Back to arcade',
    'exit.app': 'Close',
    'exit.refused': 'Close this tab yourself',

    'corner.menu': 'Menu',
    'corner.menuTitle': 'Menu (Esc)',
    'corner.mute': 'Mute',
    'corner.unmute': 'Unmute',

    'menu.paused': 'PAUSED',
    'menu.settings': 'SETTINGS',
    'menu.resume': 'RESUME',
    'menu.quit': 'END RUN',
    'menu.back': 'BACK',
    'sound.cap': 'SOUND',
    'sound.music': 'MUSIC',
    'sound.sfx': 'EFFECTS',
    'lang.cap': 'LANGUAGE',

    'hud.score': 'SCORE',
    'hud.steer': '<b>DRAG</b> OR <b>A</b>/<b>D</b> TO STEER &nbsp;·&nbsp; FIRING IS AUTOMATIC',
    'num.DMG': 'DMG',
    'num.ROF': 'ROF',
    'num.SHOTS': 'SHOTS',
    'num.HULL': 'HULL',

    'legend.shootDefuse': '⌖ SHOOT TO DEFUSE · ',
    'legend.defuseTight': '⌖ DEFUSE · ',
    'legend.shoot': '⌖ SHOOT: ',
    'unit.hp': 'HP',

    'track.damage': 'HEAVY SHOT',
    'track.fireRate': 'FORCED DRAUGHT',
    'track.multishot': 'SPLIT BARREL',
    'track.homing': 'GYRO SHELL',
    'track.lance': 'LANCE',
    'track.blast': 'BOILER BOMB',
    'track.arc': 'TESLA COIL',
    'track.burn': 'INCENDIARY',
    'track.frost': 'CRYO-VENT',
    'track.crit': 'HAIR TRIGGER',
    'track.saw': 'FLYWHEELS',
    'track.broadside': 'BROADSIDE',
    'track.shrapnel': 'DEATH BURST',
    'track.squad': 'ESCORT',
    'track.plating': 'ARMOUR PLATE',
    'track.aegis': 'AEGIS COIL',
    'track.siphon': 'CONDENSER',
    'track.thrust': 'THRUST',

    'short.damage': 'HEAVY',
    'short.fireRate': 'DRAUGHT',
    'short.multishot': 'SPLIT',
    'short.homing': 'GYRO',
    'short.lance': 'LANCE',
    'short.blast': 'BOMB',
    'short.arc': 'TESLA',
    'short.burn': 'BURN',
    'short.frost': 'CRYO',
    'short.crit': 'CRIT',
    'short.saw': 'SAWS',
    'short.broadside': 'BROAD',
    'short.shrapnel': 'BURST',
    'short.squad': 'ESCORT',
    'short.plating': 'ARMOUR',
    'short.aegis': 'AEGIS',
    'short.siphon': 'SIPHON',
    'short.thrust': 'THRUST',

    'blurb.damage': 'Heavier shells. Every bullet hits harder — the backbone of any build.',
    'blurb.fireRate': 'Stoke the boiler: shorter time between volleys. Multiplies everything else.',
    'blurb.multishot': 'Extra barrels fire side-by-side. The volley auto-tightens as it widens.',
    'blurb.homing': 'Gyroscopic shells curve toward the nearest machine. Stops missing for you.',
    'blurb.lance': 'Shots become needles that punch THROUGH enemies. LV5 ignores shield plates.',
    'blurb.blast': 'Shells detonate on impact, splashing nearby machines. Bigger boom per level.',
    'blurb.arc': 'Hits discharge chain lightning that jumps between machines. Loves crowds.',
    'blurb.burn': 'Shots ignite machines: damage over time. LV4 spreads fire on death.',
    'blurb.frost': 'Cryo rounds slow enemy gears — movement AND attacks. LV5 cancels charger dashes.',
    'blurb.crit': 'A chance for golden critical hits at a rising multiplier (up to 3x).',
    'blurb.saw': 'Brass flywheels orbit your hull, shredding what they touch. LV3+ blocks enemy shots.',
    'blurb.broadside': 'Auxiliary guns fire to the sides and rear. LV5 is a full ring of iron.',
    'blurb.shrapnel': 'Machines burst into shrapnel on death, wounding their neighbours.',
    'blurb.squad': 'Escort ships orbit you and echo your volley at half strength — lighter shells, same guns. Mortal — they soak hits for you.',
    'blurb.plating': 'Riveted armour: more hull AND a damage reduction from LV3.',
    'blurb.aegis': 'A recharging aether shield absorbs a hit outright. LV3+ shocks nearby machines.',
    'blurb.siphon': 'Condense the steam of the fallen: kills heal you, capped per second.',
    'blurb.thrust': 'Bigger engines. Strafe faster, dodge what others must tank.',

    'up.repair': 'REPAIR',
    'up.surplus': 'SURPLUS',
    'up.rust': 'RUST',
    'up.breach': 'HULL BREACH',
    'up.tradeScattergun': 'SCATTERGUN',
    'up.tradeGlassCannon': 'GLASS CANNON',
    'up.tradeOverpressure': 'OVERPRESSURE',

    'desc.levels': (n) => `${n > 0 ? '+' : ''}${n} LEVEL${Math.abs(n) === 1 ? '' : 'S'}`,
    'desc.heal': (p) => `HEAL ${p}`,
    'desc.surplus': (p, s) => `HEAL ${p} · +${s}`,
    'desc.hp': (p) => `-${p} HP`,
    'desc.defused': 'DEFUSED',
    'desc.noEffect': 'NO EFFECT',

    'up.title': 'UPGRADES',
    'up.tagline': 'Every power in the campaign — click the pips to preview any level',
    'up.previewLevel': 'Preview level',
    'up.levelN': (n) => `Level ${n}`,
    'tier.1': 'AVAILABLE FROM THE OUTSKIRTS (LEVEL 1)',
    'tier.2': 'UNLOCKS IN THE FOUNDRY (LEVEL 2)',
    'tier.3': 'UNLOCKS IN THE SHIPYARDS (LEVEL 3)',

    'slots.title': 'SELECT SAVE SLOT',
    'slot.name': (i) => `SLOT ${i}`,
    'slot.empty': 'EMPTY — NEW GAME',
    'slot.cleared': 'CAMPAIGN CLEARED ★',
    'slot.level': (n, of) => `LEVEL ${n} / ${of}`,
    'slot.score': (s) => `SCORE ${s}`,
    'slot.agoM': (m) => `${m}m ago`,
    'slot.agoH': (h) => `${h}h ago`,
    'slot.agoD': (d) => `${d}d ago`,
    'slot.replay': 'REPLAY FINALE →',
    'slot.resume': 'RESUME →',
    'slot.sure': '✕ SURE?',
    'slot.delete': 'Delete save',
    'diff.title': 'SELECT DIFFICULTY',
    'diff.easy': 'EASY',
    'diff.medium': 'MEDIUM',
    'diff.hard': 'HARD',
    'diff.easy.blurb': 'A Sunday drive. Gentler machines.',
    'diff.medium.blurb': 'The intended experience.',
    'diff.hard.blurb': 'Boilers screaming. Bring armour.',

    'level.1': 'THE OUTSKIRTS',
    'level.2': 'THE FOUNDRY',
    'level.3': 'THE SHIPYARDS',
    'level.4': 'THE IRONWORKS',
    'act.0': 'IGNITION',
    'act.1': 'PRESSURE',
    'act.2': 'OVERDRIVE',
    'act.label': (id, flavour) => `L${id} · ${flavour}`,
    'boss.foreman': 'FOREMAN',
    'boss.ironclad': 'IRONCLAD',

    'lc.heading': (n) => `LEVEL ${n} CLEAR`,
    'lc.sub': (name, next) => `${name} secured · next: ${next}`,
    'lc.notePick': 'CHOOSE <b>2</b> UPGRADES TO KEEP — THE REST IS SCRAPPED',
    'lc.noteAll': 'FEWER THAN THREE UPGRADES — EVERYTHING SURVIVES THE CROSSING',
    'lc.noteNone': 'NO UPGRADES TO CARRY — FRESH BOILER AHEAD',
    'lc.saved': 'YOUR CHOICE IS SAVED WITH YOUR PROGRESS',
    'lc.continue': 'CONTINUE →',
    'stat.score': 'SCORE',
    'stat.kills': 'KILLS',
    'stat.distance': 'DISTANCE',
    'grp.core': 'CORE',
    'grp.offense': 'OFFENSE',
    'grp.defence': 'DEFENCE',
    'end.wrecked': 'WRECKED',
    'end.build': 'FINAL BUILD',
    'end.retry': '↻  RESTART',
    'end.hint': 'R to restart',
    'end.victory': 'IRONCLAD DOWN',
    'end.again': '↻  PLAY AGAIN',
    'end.campaign': (diff) => `THE CAMPAIGN IS COMPLETE · ${diff}`.trim(),

    'pop.shield': 'SHIELD!',
    'pop.overdrive': 'OVERDRIVE!',
    'pop.steamburst': 'STEAMBURST!',
    'pop.furious': 'FURIOUS!',
    'pop.enraged': 'ENRAGED!',
    'pop.phase2': 'PHASE 2',
    'pop.shieldDown': 'SHIELD DOWN',
    'pop.allyDown': 'ALLY DOWN',
    'pop.aegis': 'AEGIS',
    'pv.hull': (n) => `HULL ${n}`,
    'pv.blocked': 'BLOCKED',
  },
};

const warned = new Set();

export function t(key, ...args) {
  let v = STRINGS[lang][key];
  if (v === undefined) {
    v = STRINGS.en[key];
    if (!warned.has(key)) {
      warned.add(key);
      console.warn(`MAXGEAR: no ${lang} text for "${key}"${v === undefined ? '' : '; showing English'}.`);
    }
    if (v === undefined) return key;
  }
  return typeof v === 'function' ? v(...args) : v;
}

export const getLang = () => lang;

/** Every piece of static markup gets its words in the current language. */
export function paintStatic(root = hasDoc ? document : null) {
  if (!root || typeof root.querySelectorAll !== 'function') return;
  for (const n of root.querySelectorAll('[data-i18n]')) n.textContent = t(n.dataset.i18n);
  for (const n of root.querySelectorAll('[data-i18n-html]')) n.innerHTML = t(n.dataset.i18nHtml);
  for (const n of root.querySelectorAll('[data-i18n-label]')) {
    const words = t(n.dataset.i18nLabel);
    n.setAttribute('aria-label', words);
    n.title = words;
  }
  for (const n of root.querySelectorAll('[data-lang]')) {
    n.setAttribute('aria-pressed', String(n.dataset.lang === lang));
  }
}

export function setLang(next) {
  if (next !== 'nb' && next !== 'en') return;
  lang = next;
  try {
    localStorage.setItem(LANG_KEY, lang);
  } catch (e) {
    // Not remembered; this visit still switches.
  }
  if (!hasDoc) return;
  document.documentElement.lang = lang;
  paintStatic(document);
  // main.js hands this to ui.js and effects.js; screen.js listens on its own.
  document.dispatchEvent(new CustomEvent('arcade:lang', { detail: lang }));
}

