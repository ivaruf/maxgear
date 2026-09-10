# You took a bad gate: something in the drivetrain binds. Two saws a quarter
# tone apart beat against each other while a crushed noise band chews its way
# downwards. The souring is the point — gate-good.rb rings, this one grinds.
use_random_seed 9012

with_fx :level, amp: 0.66 do
  with_fx :reverb, room: 0.4, mix: 0.16 do
    use_synth :dsaw
    a = play :d3, note_slide: 0.22, detune: 0.12, attack: 0.004, release: 0.3, cutoff: 84, amp: 0.8
    control a, note: :f2

    use_synth :saw
    b = play :ds3, note_slide: 0.22, attack: 0.006, release: 0.26, cutoff: 80, amp: 0.45
    control b, note: :fs2

    # Gears grinding: bit-crushed noise dragged down through a resonant band.
    with_fx :krush, gain: 6, cutoff: 88 do
      with_fx :rbpf, centre: 78, centre_slide: 0.3, res: 0.8 do |f|
        control f, centre: 58
        use_synth :gnoise
        play 60, attack: 0.01, release: 0.34, cutoff: 100, amp: 0.9
      end
    end
  end
end
