# IRONCLAD announces itself. A ship's foghorn, not a monster: two detuned low
# voices swelling under a sub, a steam whistle beating on top a beat later, and
# pressure bleeding out underneath the whole thing. Long attacks throughout —
# this is a thing too big to start quickly.
use_random_seed 2048

with_fx :level, amp: 1.0 do
  with_fx :reverb, room: 0.9, mix: 0.4 do
    use_synth :dsaw
    play :e1, detune: 0.14, attack: 0.14, sustain: 0.5, release: 0.55, cutoff: 70, amp: 0.9
    use_synth :subpulse
    play :e1, attack: 0.1, sustain: 0.6, release: 0.6, amp: 0.9

    sleep 0.18
    # Steam whistle: two voices close enough to beat against each other.
    use_synth :dpulse
    play :a4, detune: 0.25, attack: 0.06, sustain: 0.35, release: 0.4, cutoff: 105, amp: 0.22

    # Pressure release, sweeping down for the length of the roar.
    with_fx :rbpf, centre: 96, centre_slide: 0.7, res: 0.45 do |f|
      control f, centre: 66
      use_synth :bnoise
      play 60, attack: 0.12, release: 0.8, cutoff: 116, amp: 0.8
    end
  end
end
