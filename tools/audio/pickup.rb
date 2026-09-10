# A struck brass pin: the "you got it" ting for gems, crates and heals. Bright
# and tuned (the only cheerful sound in the set), with a tick underneath so it
# lands on something solid instead of floating.
use_random_seed 1180

with_fx :level, amp: 1.01 do
  with_fx :reverb, room: 0.55, mix: 0.28 do
    use_synth :pretty_bell
    play :g6, attack: 0.001, release: 0.22, amp: 0.6
    sleep 0.04
    play :c7, attack: 0.001, release: 0.16, amp: 0.32

    sample :elec_tick, rate: 1.6, amp: 0.25
  end
end
