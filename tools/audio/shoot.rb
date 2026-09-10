# One shot from the player's aether cannon. Three parts, and the order they
# were missing in matters: the breech THUMPS (weight before pitch), the charge
# FALLS AWAY (a ninth in 55 ms), and steam chuffs out behind it.
#
# The first cut of this piece was a pluck and a blip through a 196 Hz highpass,
# 69 ms long. It had no low end and no pitch movement, and it read as exactly
# what it was: a tick. A shot needs a falling sweep to read as a gun at all —
# the synthesised version this replaced swept 700 Hz down to 320 — and it needs
# body under the sweep to have any authority.
#
# Against that: this fires up to twenty times a second. So the weight sits at
# A3 rather than anywhere lower (twenty shots a second of real sub is mud, and
# a fire-rate build would produce nothing else), every voice decays fast, and
# the whole thing is under 200 ms. The runtime detunes each playback and pulls
# the gain back while the player sprays.
use_random_seed 4210

with_fx :level, amp: 0.34 do
  with_fx :hpf, cutoff: 40 do   # clears rumble only — the body has to survive
    # Breech: weight, dropping a fourth as it goes.
    use_synth :tri
    b = play :a3, note_slide: 0.05, attack: 0.001, release: 0.09, cutoff: 98, amp: 0.75
    control b, note: :e3

    # The aether discharge falling away. This is the part that makes it a gun.
    use_synth :dsaw
    s = play :f5, note_slide: 0.055, detune: 0.18, attack: 0.001, release: 0.13, cutoff: 112, amp: 0.45
    control s, note: :e4

    # Bright edge on the strike, so one shot still cuts through a firefight.
    use_synth :tri
    play :e7, attack: 0.001, release: 0.035, cutoff: 125, amp: 0.14

    # Steam out of the breech.
    use_synth :cnoise
    play 60, attack: 0.002, release: 0.07, cutoff: 114, res: 0.2, amp: 0.28
  end
end
