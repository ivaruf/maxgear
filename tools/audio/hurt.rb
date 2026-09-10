# Your rig takes a hit: hull clang, a rivet letting go, and then steam leaking
# out of the breach. The leak is the informative part — it is the only sound in
# the game that says "you are damaged" rather than "something happened", so it
# sits high enough in the mix to be heard through a firefight.
use_random_seed 7126

with_fx :level, amp: 0.85 do
  with_fx :reverb, room: 0.45, mix: 0.2 do
    # The frame takes it, and sags.
    use_synth :dsaw
    s = play :fs2, note_slide: 0.22, detune: 0.25, attack: 0.004, release: 0.3, cutoff: 88, amp: 0.9
    control s, note: :cs1

    sample :perc_impact1, rate: 0.9, attack: 0.002, sustain: 0.08, release: 0.3, amp: 0.6

    sleep 0.05
    # A rivet gives: high, brittle, brief.
    use_synth :pluck
    play :d6, coef: 0.35, release: 0.08, amp: 0.3

    sleep 0.06
    with_fx :rbpf, centre: 92, centre_slide: 0.45, res: 0.6 do |f|
      control f, centre: 66
      use_synth :pnoise
      play 60, attack: 0.04, release: 0.5, cutoff: 112, amp: 0.75
    end
  end
end
