# A shot lands on iron: body thud plus two inharmonic partials. Iron rings
# sour, never in tune, which is the whole character of this sound — the
# partials are a major third apart on purpose so nothing here reads as musical.
# Fires nearly as often as shoot.rb, so it stays under 150 ms.
use_random_seed 8817

with_fx :level, amp: 0.6 do
  with_fx :reverb, room: 0.3, mix: 0.12 do
    # The plate takes the hit: low and stopped dead.
    use_synth :tri
    play :a3, attack: 0.001, decay: 0.02, sustain: 0, release: 0.05, cutoff: 90, amp: 0.7

    # Metal answering back.
    use_synth :pluck
    play :cs6, coef: 0.4, pluck_decay: 40, noise_amp: 0.5, release: 0.11, amp: 0.5
    play :g6, coef: 0.3, pluck_decay: 40, noise_amp: 0.4, release: 0.07, amp: 0.3

    # Grit of the strike itself. hat_metal runs 0.9 s, which is a ring, not a
    # strike — every sample here is cut to its transient with an explicit
    # sustain, because a sample with only `release:` set plays in full.
    sample :hat_metal, rate: 1.4, attack: 0.001, sustain: 0.02, release: 0.08, amp: 0.35
  end
end
