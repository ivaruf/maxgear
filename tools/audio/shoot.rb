# One shot from the player's aether cannon: a brass tock with a cyan spark on
# top and a puff out of the breech. This fires up to twenty times a second, so
# it is deliberately small, dry and short — the runtime detunes every playback,
# so a spray reads as texture rather than one click repeated.
use_random_seed 4210

with_fx :level, amp: 1.67 do
  with_fx :hpf, cutoff: 55 do
    # Brass tock: a plucked string stopped almost as soon as it is struck.
    use_synth :pluck
    play :a5, coef: 0.15, pluck_decay: 60, noise_amp: 0.4, release: 0.06, amp: 0.5

    # The aether itself — bright, an octave and a half up, gone in 30 ms.
    use_synth :tri
    play :e7, attack: 0.001, release: 0.03, cutoff: 125, amp: 0.18

    # Steam escaping the breech behind the shot.
    use_synth :cnoise
    play 60, attack: 0.002, release: 0.035, cutoff: 118, res: 0.2, amp: 0.22
  end
end
