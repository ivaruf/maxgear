# Level clear, and the campaign victory. A four-note fanfare on the band organ
# with brass an octave below each note, then the bell held over one long
# release of steam: the boiler stood down, the run survived.
use_random_seed 3030

with_fx :level, amp: 1.62 do
  with_fx :reverb, room: 0.8, mix: 0.36 do
    [:c5, :e5, :g5, :c6].each do |n|
      use_synth :organ_tonewheel
      play n, attack: 0.01, sustain: 0.1, release: 0.22, amp: 0.55
      use_synth :dsaw
      play note(n) - 12, detune: 0.1, attack: 0.012, sustain: 0.08, release: 0.24, cutoff: 92, amp: 0.3
      sleep 0.12
    end

    use_synth :pretty_bell
    play :c6, attack: 0.003, release: 1.4, amp: 0.6
    play :g6, attack: 0.003, release: 0.9, amp: 0.28

    with_fx :rbpf, centre: 100, centre_slide: 0.6, res: 0.4 do |f|
      control f, centre: 78
      use_synth :bnoise
      play 60, attack: 0.08, release: 0.6, cutoff: 118, amp: 0.4
    end
  end
end
