# You took a good gate: the crew rings you through. Two brass bells a fifth
# apart, struck a beat behind each other, with a dull bell an octave down for
# weight. This is the most tuned, most consonant sound in the game — it has to
# be, because gate-bad.rb is the same gesture deliberately soured.
use_random_seed 6203

with_fx :level, amp: 1.04 do
  with_fx :reverb, room: 0.7, mix: 0.35 do
    use_synth :pretty_bell
    play :d5, attack: 0.002, release: 0.7, amp: 0.7
    use_synth :dull_bell
    play :d4, attack: 0.002, release: 0.55, amp: 0.35

    sleep 0.13

    use_synth :pretty_bell
    play :a5, attack: 0.002, release: 0.8, amp: 0.6

    # Sheen coming off the strike — perc_bell is 6.7 s long, so it is cut to
    # its attack (an explicit sustain is the only thing that truncates a
    # sample; `release:` on its own fades the whole length).
    sample :perc_bell, rate: 1.2, attack: 0.002, sustain: 0.1, release: 0.7, amp: 0.2
  end
end
