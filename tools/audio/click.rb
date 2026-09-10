# A brass lever thrown on the control desk. Every menu tap plays this, so it
# is quiet, dry and instant: contact tick, stopped pluck, nothing else.
use_random_seed 5150

with_fx :level, amp: 1.49 do
  use_synth :pluck
  play :a5, coef: 0.1, pluck_decay: 70, noise_amp: 0.3, release: 0.055, amp: 0.55

  use_synth :sine
  play :e6, attack: 0.001, release: 0.035, amp: 0.25

  sample :elec_tick, rate: 1.25, amp: 0.3
end
