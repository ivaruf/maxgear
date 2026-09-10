#!/usr/bin/env bash
# Rebuilds every audio asset MAXGEAR ships. Run from the game root:
#
#   tools/audio/build.sh
#
# Two halves, because the two kinds of audio arrive differently.
#
# EFFECTS — the thirteen Sonic Pi pieces beside this script. The hub's
#   render.rb records them in realtime through one engine boot (they are
#   audible while it works; that is not a fault), and the hub's
#   encode-oneshots.mjs trims each take and lifts the WHOLE SET by one shared
#   gain, so the balance authored in the `amp:` opts survives into the game.
#   The seconds below are recording windows, not durations: each is the piece
#   plus room for its reverb tail, and encode-oneshots trims back to the sound.
#
#   The `with_fx :level, amp:` at the top of each piece is CALIBRATION, not
#   taste. Peak level does not follow from the voice amps in any way you can
#   predict — a 60 ms pluck and a kick sample at the same nominal amp measured
#   28 dB apart — so the wrapper is set from what the encoder reports, to land
#   the spread the game wants: the shot tick ~13 dB under an explosion, the
#   menu click just under the shot, the boss roar on top. Change a voice and
#   you have to re-read the table encode-oneshots prints and re-set the level.
#
# MUSIC — maxgear-theme.m4a, the master as delivered. It is Opus inside an MP4
#   container, which Chrome decodes and Safari flatly does not, so the shipped
#   asset is a straight AAC transcode. Trimmed to the music (0.16 s of leading
#   silence, and the dead ~0.9 s after the track's own fade-out) and otherwise
#   left alone: the master already peaks at -2.4 dBFS, AAC decodes hotter than
#   its source, and the runtime's music bus does the mixing anyway.
#
# Needs ffmpeg, node, and a real audio device — Sonic Pi records through
# CoreAudio and will not run inside a sandbox.
set -euo pipefail

cd "$(dirname "$0")/../.."   # the game root, whatever it is called

HUB_TOOLS=../tools/audio
SP_RUBY="${SONIC_PI_APP:-/Applications/Sonic Pi.app}/Contents/Resources/app/server/native/ruby/bin/ruby"
WAV="${TMPDIR:-/tmp}/maxgear-audio-wav"
OUT=assets/audio

PIECES=(
  shoot=1.5
  hit=1.5
  click=1.2
  gate-charge=1.2
  pickup=2
  gate-good=3.5
  gate-bad=2.5
  enemy-die=2.5
  hurt=2.5
  explode=3
  boss-roar=4
  win=5
  lose=5
)

mkdir -p "$WAV" "$OUT"

echo "== effects: recording ${#PIECES[@]} pieces (realtime, audible) =="
SONIC_PI_PIECES=tools/audio "$SP_RUBY" "$HUB_TOOLS/render.rb" "$WAV" "${PIECES[@]}"

echo "== effects: trim + one shared gain + mono AAC =="
node "$HUB_TOOLS/encode-oneshots.mjs" "$WAV" "$OUT"

# Only when the master is newer than what we shipped. Tuning one effect is a
# normal afternoon here, and rewriting a 2.9 MB binary into git history on
# every pass of that is not.
if [ ! -f "$OUT/music-theme.m4a" ] || [ tools/audio/maxgear-theme.m4a -nt "$OUT/music-theme.m4a" ]; then
  echo "== music: Opus master -> AAC =="
  ffmpeg -hide_banner -nostdin -y -i tools/audio/maxgear-theme.m4a \
    -af "atrim=start=0.16:end=185.65,asetpts=PTS-STARTPTS,afade=t=in:st=0:d=0.05" \
    -vn -ac 2 -ar 48000 -c:a aac -b:a 128k -movflags +faststart \
    "$OUT/music-theme.m4a"
else
  echo "== music: up to date (touch the master to force) =="
fi

echo
ls -la "$OUT"
