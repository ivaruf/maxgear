# One shot from the player's aether cannon: a pew. The SWEEP is the sound —
# a resonant voice falling two and a half octaves in 50 ms with the filter
# chasing it down — and the other two voices exist only to sharpen the
# transient it starts on.
#
# Everything here is set by the fact that it has to hold up at fourteen shots
# a second (fireRate LV5 under overdrive fires a volley every 70 ms, and
# audio.shoot is called once per volley, not once per projectile):
#
#   110 ms long, so 1.7 voices overlap at the top rate and one at LV5;
#   almost no low end — bass is what sums into mud when a sound repeats, and
#     the highpass at 147 Hz sits just under where the sweep lands;
#   bone dry, because a reverb tail would beat against the next shot;
#   short release even on the resonant voice, for the same reason.
#
# The runtime alternates successive shots a whole tone apart, which is what
# makes a stream of these read as pew-pew rather than one sample stuttering.
use_random_seed 4210

with_fx :level, amp: 0.36 do
  with_fx :hpf, cutoff: 50 do
    # The pew. res is high enough for the filter to squelch as it falls, which
    # is the whole character; wave 1 (pulse) has more edge than the saw.
    use_synth :tb303
    p = play :a6, note_slide: 0.05,
             cutoff: 130, cutoff_slide: 0.055, res: 0.88, wave: 1, pulse_width: 0.45,
             attack: 0.001, release: 0.075, amp: 0.8
    control p, note: :d4, cutoff: 95

    # Spark at the top of the sweep, gone in 25 ms.
    use_synth :tri
    play :e7, attack: 0.001, release: 0.025, cutoff: 128, amp: 0.16

    # A click to land it on. No thump: a body big enough to feel at three
    # shots a second is a body big enough to pile up at fourteen.
    use_synth :cnoise
    play 60, attack: 0.001, release: 0.02, cutoff: 120, res: 0.3, amp: 0.2
  end
end
