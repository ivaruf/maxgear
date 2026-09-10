# A hammer blow on a gate that is still charging. The runtime plays this back
# faster as the gauge fills, so a pumped gate reads as a rising ladder — which
# only works if the piece is one dry strike with no tail to smear across the
# next one. Nothing sustained belongs in here.
use_random_seed 4477

with_fx :level, amp: 1.39 do
  use_synth :pluck
  play :a5, coef: 0.25, pluck_decay: 50, noise_amp: 0.35, release: 0.09, amp: 0.6

  # Anvil ting on top of the blow.
  use_synth :tri
  play :a6, attack: 0.001, release: 0.045, cutoff: 124, amp: 0.25

  sample :hat_metal, rate: 1.8, attack: 0.001, sustain: 0.01, release: 0.05, amp: 0.2
end
